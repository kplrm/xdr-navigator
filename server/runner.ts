import { createHash, randomUUID } from 'crypto';
import { Conversation, McpConnection, ModelConnection, NavigatorAgent, RunStep } from '../common/types';
import { ChatMessage, ChatTool, complete } from './model_client';
import { callTool } from './mcp_client';
import { Store } from './store';

function step(kind: RunStep['kind'], title: string, input?: unknown): RunStep {
  return { id: randomUUID(), kind, title, input, status: 'running', startedAt: new Date().toISOString() };
}

function functionName(key: string): string {
  return `xdr_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

export async function runTurn(store: Store, conversationId: string, turnId: string): Promise<void> {
  let conversation = await store.get<Conversation>('conversation', conversationId);
  if (!conversation) return;
  let turn = conversation.turns.find((item) => item.id === turnId);
  if (!turn) return;
  const persist = async () => {
    const current = await store.get<Conversation>('conversation', conversationId);
    if (!current) throw new Error('Conversation deleted');
    current.title = conversation!.title;
    current.turns = current.turns.map((item) => item.id === turnId ? turn! : item);
    current.updatedAt = new Date().toISOString();
    await store.save('conversation', current);
    conversation = current;
  };
  try {
    const model = await store.get<ModelConnection>('model', turn.modelId);
    const agent = await store.get<NavigatorAgent>('agent', turn.agentId);
    if (!model || !agent) throw new Error('Selected model or agent no longer exists');

    if (conversation.turns[0].id === turnId) {
      const titleStep = step('model', 'Creating conversation title');
      turn.steps.push(titleStep); await persist();
      try {
        const title = await complete(model, [
          { role: 'system', content: 'Create a concise conversation title of at most six words. Return only the title.' },
          { role: 'user', content: turn.prompt },
        ]);
        conversation.title = (title.message.content || '').replace(/[\r\n"']/g, ' ').trim().slice(0, 80) || turn.prompt.slice(0, 60);
        titleStep.status = 'done';
      } catch (error) {
        conversation.title = turn.prompt.slice(0, 60);
        titleStep.status = 'error'; titleStep.detail = (error as Error).message;
      }
      titleStep.completedAt = new Date().toISOString(); await persist();
    }

    const messages: ChatMessage[] = [{ role: 'system', content: agent.systemContext }];
    for (const item of conversation.turns) {
      messages.push({ role: 'user', content: item.prompt });
      if (item.id !== turnId && item.answer) messages.push({ role: 'assistant', content: item.answer });
      if (item.id === turnId) break;
    }
    const servers = await store.list<McpConnection>('mcp');
    const toolMap = new Map<string, { server: McpConnection; name: string }>();
    const tools: ChatTool[] = [];
    for (const key of agent.toolKeys) {
      const split = key.indexOf(':');
      if (split < 0) continue;
      const server = servers.find((item) => item.id === key.slice(0, split));
      const remoteName = key.slice(split + 1);
      const remote = server?.tools.find((item) => item.name === remoteName);
      if (!server || !remote) continue;
      const name = functionName(key);
      toolMap.set(name, { server, name: remoteName });
      tools.push({ type: 'function', function: { name, description: `${server.name}: ${remote.description}`, parameters: remote.inputSchema } });
    }

    for (let round = 0; round < 8; round++) {
      const modelStep = step('model', 'Agent thinking');
      turn.steps.push(modelStep); await persist();
      const result = await complete(model, messages, tools);
      modelStep.status = 'done'; modelStep.completedAt = new Date().toISOString();
      const calls = result.message.tool_calls || [];
      modelStep.detail = result.message.content?.trim() || (calls.length ? `Selected ${calls.length} tool${calls.length === 1 ? '' : 's'} for this step.` : 'Prepared an answer from the available context.');
      if (!calls.length) {
        turn.answer = result.message.content || '';
        turn.status = 'done';
        await persist();
        return;
      }
      messages.push(result.message);
      await persist();
      for (const call of calls) {
        const selected = toolMap.get(call.function.name);
        const toolStep = step('tool', selected ? `${selected.server.name} · ${selected.name}` : call.function.name);
        turn.steps.push(toolStep); await persist();
        let content: string;
        try {
          if (!selected) throw new Error('Tool is not assigned to this agent');
          const args = JSON.parse(call.function.arguments || '{}');
          toolStep.input = args;
          const output = await callTool(selected.server, selected.name, args);
          content = JSON.stringify(output).slice(0, 20000);
          toolStep.output = content;
          toolStep.status = 'done';
        } catch (error) {
          content = `Tool error: ${(error as Error).message}`;
          toolStep.output = content; toolStep.status = 'error';
        }
        toolStep.completedAt = new Date().toISOString();
        messages.push({ role: 'tool', tool_call_id: call.id, content });
        await persist();
      }
    }
    throw new Error('Agent exceeded the maximum tool-call rounds');
  } catch (error) {
    if ((error as Error).message === 'Conversation deleted') return;
    turn.status = 'error'; turn.error = (error as Error).message;
    await persist();
  }
}
