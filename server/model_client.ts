import { ModelConnection } from '../common/types';
import { unseal } from './security';

export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: ToolCall[] }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatTool { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ChatResult { message: ChatMessage; usage?: unknown }

export async function complete(model: ModelConnection, messages: ChatMessage[], tools: ChatTool[] = []): Promise<ChatResult> {
  const url = new URL(model.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Model endpoint must be an HTTP(S) URL without embedded credentials');
  }
  const key = unseal(model.apiKey);
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: (AbortSignal as any).timeout(120000),
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: model.model, messages, stream: false, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Model endpoint returned ${response.status}: ${raw.slice(0, 300)}`);
  let parsed: { choices?: Array<{ message?: ChatMessage }>; usage?: unknown };
  try { parsed = JSON.parse(raw); } catch { throw new Error('Model endpoint returned invalid JSON'); }
  const message = parsed.choices?.[0]?.message;
  if (!message) throw new Error('Model endpoint returned no assistant message');
  return { message, usage: parsed.usage };
}
