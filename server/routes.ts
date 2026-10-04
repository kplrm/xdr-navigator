import { schema } from '@osd/config-schema';
import { randomUUID } from 'crypto';
import type { CoreSetup, IRouter, Logger } from '../../OpenSearch-Dashboards/src/core/server';
import { Conversation, ConversationTurn, McpConnection, ModelConnection, NavigatorAgent, Visibility } from '../common/types';
import { complete } from './model_client';
import { discoverTools } from './mcp_client';
import { runTurn } from './runner';
import { encryptionReady, principalFor, Principal, seal } from './security';
import { Store } from './store';

// Dashboards exposes body and path values only when their schemas are declared.
const bodyValidation = { body: schema.object({}, { unknowns: 'allow' }) };
const idValidation = { params: schema.object({ id: schema.string() }) };
const idBodyValidation = { ...idValidation, ...bodyValidation };

type Handler = (store: Store, actor: Principal, request: any) => Promise<unknown>;
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function requireAdmin(actor: Principal) { if (!actor.admin) throw new HttpError(403, 'Navigator administrator role required'); }
function requireRead(chat: Conversation, actor: Principal) {
  if (!actor.admin && chat.ownerId !== actor.id && chat.visibility !== 'shared') throw new HttpError(404, 'Conversation not found');
}
function requireOwner(chat: Conversation, actor: Principal) {
  if (!actor.admin && chat.ownerId !== actor.id) throw new HttpError(403, 'Conversation owner or administrator required');
}
function text(value: unknown, field: string, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${field} is required and must be under ${max} characters`);
  return value.trim();
}
function endpoint(value: unknown): string {
  let url: URL;
  try { url = new URL(text(value, 'URL', 2000)); }
  catch { throw new HttpError(400, 'A valid HTTP(S) URL is required'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new HttpError(400, 'A plain HTTP(S) URL is required');
  return url.toString();
}
function visibleModel(model: ModelConnection): ModelConnection {
  const { apiKey, ...rest } = model;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}
function visibleMcp(server: McpConnection): McpConnection {
  const { authToken, ...rest } = server;
  return { ...rest, hasAuthToken: Boolean(authToken) };
}

export function registerRoutes(router: IRouter, core: CoreSetup, storePromise: Promise<Store>, logger: Logger) {
  const route = router as any;
  const activeRuns = new Set<string>();
  const reserveRun = (chat: Conversation) => {
    if (activeRuns.has(chat.id) || chat.turns.some((turn) => turn.status === 'running')) throw new HttpError(409, 'Wait for the current answer');
    activeRuns.add(chat.id);
  };
  const launch = (store: Store, chat: Conversation, turn: ConversationTurn) => {
    void runTurn(store, chat.id, turn.id).catch((error) => logger.error(`xdr-navigator run error: ${error}`)).finally(() => activeRuns.delete(chat.id));
  };
  const wrap = (handler: Handler) => async (context: any, request: any, response: any) => {
    try {
      const actor = await principalFor(core, context, request);
      const body = await handler(await storePromise, actor, request);
      return response.ok({ body });
    } catch (error) {
      const problem = error as Error;
      if (!(error instanceof HttpError)) logger.error(`xdr-navigator route error: ${problem.stack || problem.message}`);
      const status = error instanceof HttpError ? error.status : problem.message.includes('identity') || problem.message.includes('Authentication') ? 401 : 500;
      return response.custom({ statusCode: status, body: { message: problem.message } });
    }
  };
  const id = (request: any) => text(request.params.id, 'ID', 100);
  const getChat = async (store: Store, request: any, actor: Principal) => {
    const chat = await store.get<Conversation>('conversation', id(request));
    if (!chat) throw new HttpError(404, 'Conversation not found');
    requireRead(chat, actor);
    return chat;
  };

  route.get({ path: '/api/xdr-navigator/session', validate: false }, wrap(async (_store, actor) => ({ user: actor, encryptionReady: encryptionReady() })));

  route.get({ path: '/api/xdr-navigator/models', validate: false }, wrap(async (store, actor) => (await store.list<ModelConnection>('model')).map((model) => {
    const visible = visibleModel(model);
    return actor.admin ? visible : { ...visible, url: '' };
  })));
  route.post({ path: '/api/xdr-navigator/models/test', validate: bodyValidation }, wrap(async (store, actor, request) => {
    requireAdmin(actor);
    const body = request.body || {};
    const old = body.id ? await store.get<ModelConnection>('model', body.id) : undefined;
    const model: ModelConnection = {
      id: old?.id || '', name: text(body.name, 'Name', 100), url: endpoint(body.url), model: text(body.model, 'Model', 150),
      apiKey: body.apiKey ? seal(text(body.apiKey, 'API key', 10000)) : old?.apiKey,
    };
    const result = await complete(model, [{ role: 'user', content: 'Reply with OK.' }]);
    return { ok: true, response: result.message.content };
  }));
  route.post({ path: '/api/xdr-navigator/models', validate: bodyValidation }, wrap(async (store, actor, request) => {
    requireAdmin(actor);
    const body = request.body || {};
    const old = body.id ? await store.get<ModelConnection>('model', body.id) : undefined;
    const name = text(body.name, 'Name', 100);
    const models = await store.list<ModelConnection>('model');
    if (models.some((item) => item.id !== old?.id && item.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Model connection name already exists');
    const model: ModelConnection = {
      id: old?.id || randomUUID(), name, url: endpoint(body.url), model: text(body.model, 'Model', 150),
      apiKey: body.apiKey ? seal(text(body.apiKey, 'API key', 10000)) : old?.apiKey,
    };
    await store.save('model', model); return visibleModel(model);
  }));
  route.delete({ path: '/api/xdr-navigator/models/{id}', validate: idValidation }, wrap(async (store, actor, request) => {
    requireAdmin(actor); await store.delete('model', id(request)); return { deleted: true };
  }));

  route.get({ path: '/api/xdr-navigator/mcp', validate: false }, wrap(async (store, actor) => (await store.list<McpConnection>('mcp')).map((server) => {
    const visible = visibleMcp(server);
    return actor.admin ? visible : { ...visible, url: '' };
  })));
  route.post({ path: '/api/xdr-navigator/mcp/test', validate: bodyValidation }, wrap(async (store, actor, request) => {
    requireAdmin(actor);
    const body = request.body || {};
    const old = body.id ? await store.get<McpConnection>('mcp', body.id) : undefined;
    const server: McpConnection = {
      id: old?.id || '', name: text(body.name, 'Name', 100), url: endpoint(body.url),
      authToken: body.authToken ? seal(text(body.authToken, 'Token', 10000)) : old?.authToken, tools: [],
    };
    return { tools: await discoverTools(server) };
  }));
  route.post({ path: '/api/xdr-navigator/mcp', validate: bodyValidation }, wrap(async (store, actor, request) => {
    requireAdmin(actor);
    const body = request.body || {};
    const old = body.id ? await store.get<McpConnection>('mcp', body.id) : undefined;
    const name = text(body.name, 'Name', 100);
    const servers = await store.list<McpConnection>('mcp');
    if (servers.some((item) => item.id !== old?.id && item.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'MCP server name already exists');
    const server: McpConnection = {
      id: old?.id || randomUUID(), name, url: endpoint(body.url),
      authToken: body.authToken ? seal(text(body.authToken, 'Token', 10000)) : old?.authToken,
      tools: [],
    };
    server.tools = await discoverTools(server);
    server.lastDiscoveredAt = new Date().toISOString();
    await store.save('mcp', server); return visibleMcp(server);
  }));
  route.post({ path: '/api/xdr-navigator/mcp/{id}/refresh', validate: idValidation }, wrap(async (store, actor, request) => {
    requireAdmin(actor);
    const server = await store.get<McpConnection>('mcp', id(request));
    if (!server) throw new HttpError(404, 'MCP server not found');
    server.tools = await discoverTools(server); server.lastDiscoveredAt = new Date().toISOString();
    await store.save('mcp', server); return visibleMcp(server);
  }));
  route.delete({ path: '/api/xdr-navigator/mcp/{id}', validate: idValidation }, wrap(async (store, actor, request) => {
    requireAdmin(actor); await store.delete('mcp', id(request)); return { deleted: true };
  }));

  route.get({ path: '/api/xdr-navigator/agents', validate: false }, wrap(async (store) => store.list<NavigatorAgent>('agent')));
  route.post({ path: '/api/xdr-navigator/agents', validate: bodyValidation }, wrap(async (store, actor, request) => {
    requireAdmin(actor);
    const body = request.body || {};
    const old = body.id ? await store.get<NavigatorAgent>('agent', body.id) : undefined;
    const agents = await store.list<NavigatorAgent>('agent');
    const name = text(body.name, 'Name', 100);
    if (agents.some((item) => item.id !== old?.id && item.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Agent name already exists');
    const servers = await store.list<McpConnection>('mcp');
    const allowed = new Set(servers.flatMap((item) => item.tools.map((tool) => `${item.id}:${tool.name}`)));
    const toolKeys = Array.isArray(body.toolKeys) ? body.toolKeys.filter((key: unknown) => typeof key === 'string' && allowed.has(key)) : [];
    const agent: NavigatorAgent = {
      id: old?.id || randomUUID(), name, description: typeof body.description === 'string' ? body.description.slice(0, 1000) : '',
      systemContext: text(body.systemContext, 'System context', 30000), toolKeys, builtIn: old?.builtIn,
    };
    await store.save('agent', agent); return agent;
  }));
  route.delete({ path: '/api/xdr-navigator/agents/{id}', validate: idValidation }, wrap(async (store, actor, request) => {
    requireAdmin(actor);
    const agent = await store.get<NavigatorAgent>('agent', id(request));
    if (!agent) throw new HttpError(404, 'Agent not found');
    if (agent.builtIn) throw new HttpError(400, 'The default agent cannot be deleted');
    await store.delete('agent', agent.id); return { deleted: true };
  }));

  route.get({ path: '/api/xdr-navigator/conversations', validate: false }, wrap(async (store, actor) => {
    const all = await store.list<Conversation>('conversation');
    return all.filter((chat) => actor.admin || chat.ownerId === actor.id || chat.visibility === 'shared')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ turns, ...chat }) => ({ ...chat, turnCount: turns.length }));
  }));
  route.post({ path: '/api/xdr-navigator/conversations', validate: bodyValidation }, wrap(async (store, actor, request) => {
    const body = request.body || {};
    const models = await store.list<ModelConnection>('model');
    const agents = await store.list<NavigatorAgent>('agent');
    const modelId = body.modelId || models[0]?.id;
    const agentId = body.agentId || agents[0]?.id;
    if (!models.some((item) => item.id === modelId)) throw new HttpError(400, 'Select a model connection');
    if (!agents.some((item) => item.id === agentId)) throw new HttpError(400, 'Select an agent');
    const now = new Date().toISOString();
    const chat: Conversation = {
      id: randomUUID(), ownerId: actor.id, ownerName: actor.name, title: 'New conversation', visibility: 'private',
      modelId, agentId, turns: [], createdAt: now, updatedAt: now,
    };
    await store.save('conversation', chat); return chat;
  }));
  route.get({ path: '/api/xdr-navigator/conversations/{id}', validate: idValidation }, wrap(async (store, actor, request) => getChat(store, request, actor)));
  route.delete({ path: '/api/xdr-navigator/conversations/{id}', validate: idValidation }, wrap(async (store, actor, request) => {
    const chat = await getChat(store, request, actor); requireOwner(chat, actor);
    await store.delete('conversation', chat.id); return { deleted: true };
  }));
  route.put({ path: '/api/xdr-navigator/conversations/{id}/visibility', validate: idBodyValidation }, wrap(async (store, actor, request) => {
    const chat = await getChat(store, request, actor); requireOwner(chat, actor);
    const visibility: Visibility = request.body?.visibility;
    if (visibility !== 'private' && visibility !== 'shared') throw new HttpError(400, 'Visibility must be private or shared');
    chat.visibility = visibility; chat.updatedAt = new Date().toISOString(); await store.save('conversation', chat); return chat;
  }));

  const start = async (store: Store, chat: Conversation, turn: ConversationTurn) => {
    reserveRun(chat);
    try {
      chat.turns.push(turn); chat.modelId = turn.modelId; chat.agentId = turn.agentId;
      chat.updatedAt = new Date().toISOString(); await store.save('conversation', chat);
      launch(store, chat, turn);
      return chat;
    } catch (error) { activeRuns.delete(chat.id); throw error; }
  };
  route.post({ path: '/api/xdr-navigator/conversations/{id}/turns', validate: idBodyValidation }, wrap(async (store, actor, request) => {
    const chat = await getChat(store, request, actor);
    const prompt = text(request.body?.prompt, 'Message', 30000);
    const modelId = request.body?.modelId || chat.modelId;
    const agentId = request.body?.agentId || chat.agentId;
    if (!await store.get('model', modelId) || !await store.get('agent', agentId)) throw new HttpError(400, 'Selected model or agent is unavailable');
    return start(store, chat, {
      id: randomUUID(), authorId: actor.id, authorName: actor.name, prompt, answer: '', modelId, agentId,
      status: 'running', steps: [], createdAt: new Date().toISOString(),
    });
  }));
  const restart = async (store: Store, actor: Principal, request: any, edit: boolean) => {
    const chat = await getChat(store, request, actor);
    const turn = chat.turns[chat.turns.length - 1];
    if (!turn) throw new HttpError(400, 'Conversation has no message to retry');
    if (turn.status === 'running') throw new HttpError(409, 'Wait for the current answer');
    if (!actor.admin && turn.authorId !== actor.id) throw new HttpError(403, 'Only the author can edit or retry the latest message');
    if (edit) text(request.body?.prompt, 'Message', 30000);
    reserveRun(chat);
    if (edit) turn.prompt = text(request.body?.prompt, 'Message', 30000);
    turn.answer = ''; turn.error = undefined; turn.status = 'running'; turn.steps = [];
    if (edit && chat.turns.length === 1) chat.title = 'New conversation';
    try {
      chat.updatedAt = new Date().toISOString(); await store.save('conversation', chat);
      launch(store, chat, turn);
      return chat;
    } catch (error) { activeRuns.delete(chat.id); throw error; }
  };
  route.post({ path: '/api/xdr-navigator/conversations/{id}/edit-last', validate: idBodyValidation }, wrap((store, actor, request) => restart(store, actor, request, true)));
  route.post({ path: '/api/xdr-navigator/conversations/{id}/retry-last', validate: idValidation }, wrap((store, actor, request) => restart(store, actor, request, false)));
}
