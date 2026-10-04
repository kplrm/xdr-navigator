const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const fs = require('node:fs');
const path = require('node:path');
const ts = require(path.join(process.env.OSD_ROOT || path.resolve(__dirname, '../../OpenSearch-Dashboards'), 'node_modules/typescript'));
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true } });
  module._compile(output.outputText, filename);
};

const { discoverTools, callTool } = require('../server/mcp_client.ts');
const { runTurn } = require('../server/runner.ts');
const { registerRoutes } = require('../server/routes.ts');

async function serve(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const output = await handler(body, req);
    res.writeHead(output.status || 200, { 'content-type': 'application/json', ...(output.headers || {}) });
    res.end(output.body === undefined ? '' : JSON.stringify(output.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('discovers and executes a FastMCP-style HTTP tool', async () => {
  const calls = [];
  const remote = await serve((body, req) => {
    calls.push([body.method, req.headers['mcp-session-id']]);
    if (body.method === 'initialize') return { headers: { 'mcp-session-id': 'test-session' }, body: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {} } } };
    if (body.method === 'notifications/initialized') return { status: 202 };
    if (body.method === 'tools/list') return { body: { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'lookup', description: 'Look up an item', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }] } } };
    if (body.method === 'tools/call') return { body: { jsonrpc: '2.0', id: body.id, result: { structuredContent: { found: body.params.arguments.id } } } };
    throw new Error(`Unexpected MCP method ${body.method}`);
  });
  try {
    const server = { id: 'mcp', name: 'Test', url: `${remote.url}/mcp`, tools: [] };
    const tools = await discoverTools(server);
    assert.equal(tools[0].name, 'lookup');
    assert.deepEqual(await callTool(server, 'lookup', { id: '42' }), { found: '42' });
    assert.ok(calls.some(([method, session]) => method === 'tools/list' && session === 'test-session'));
  } finally { await remote.close(); }
});

test('first turn generates a title, runs an assigned tool, and stores the answer', async () => {
  const mcp = await serve((body) => {
    if (body.method === 'initialize') return { body: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } } };
    if (body.method === 'notifications/initialized') return { status: 202 };
    if (body.method === 'tools/call') return { body: { jsonrpc: '2.0', id: body.id, result: { structuredContent: { value: 42 } } } };
    throw new Error('Unexpected MCP call');
  });
  let modelRequests = 0;
  const llm = await serve((body) => {
    modelRequests++;
    const title = body.messages[0].content.startsWith('Create a concise');
    const toolReturned = body.messages.some((item) => item.role === 'tool');
    const message = title ? { role: 'assistant', content: 'Investigate DNS' }
      : toolReturned ? { role: 'assistant', content: 'The result is 42.' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"id":"dns"}' } }] };
    return { body: { choices: [{ message }] } };
  });
  const now = new Date().toISOString();
  const records = {
    conversation: [{ id: 'chat', ownerId: 'alice', ownerName: 'Alice', title: 'New conversation', visibility: 'private', modelId: 'model', agentId: 'agent', createdAt: now, updatedAt: now, turns: [{ id: 'turn', authorId: 'alice', authorName: 'Alice', prompt: 'Investigate DNS', answer: '', modelId: 'model', agentId: 'agent', status: 'running', steps: [], createdAt: now }] }],
    model: [{ id: 'model', name: 'Test', url: `${llm.url}/v1/chat/completions`, model: 'test-model' }],
    agent: [{ id: 'agent', name: 'Agent', description: '', systemContext: 'Investigate.', toolKeys: ['mcp:lookup'] }],
    mcp: [{ id: 'mcp', name: 'MCP', url: `${mcp.url}/mcp`, tools: [{ name: 'lookup', description: 'Lookup DNS', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }] }],
  };
  const store = {
    get: async (kind, id) => structuredClone(records[kind].find((item) => item.id === id)),
    list: async (kind) => structuredClone(records[kind]),
    save: async (kind, value) => { records[kind] = records[kind].filter((item) => item.id !== value.id).concat(structuredClone(value)); },
  };
  try {
    await runTurn(store, 'chat', 'turn');
    const chat = records.conversation[0];
    assert.equal(chat.title, 'Investigate DNS');
    assert.equal(chat.turns[0].answer, 'The result is 42.');
    assert.equal(chat.turns[0].status, 'done');
    assert.equal(chat.turns[0].steps.filter((item) => item.kind === 'tool').length, 1);
    assert.equal(modelRequests, 3);
  } finally { await Promise.all([mcp.close(), llm.close()]); }
});

test('private chats deny other users while admins and shared readers can read', async () => {
  const handlers = {};
  const router = new Proxy({}, { get: (_target, method) => (config, handler) => { handlers[`${method} ${config.path}`] = handler; } });
  const chat = { id: 'chat', ownerId: 'alice', ownerName: 'Alice', title: 'Private', visibility: 'private', turns: [], createdAt: '', updatedAt: '', modelId: '', agentId: '' };
  const store = { get: async () => chat };
  const core = { http: { auth: { get: (req) => ({ status: 'authenticated', state: { authInfo: { user_id: req.user, roles: req.roles || [] } } }) } } };
  registerRoutes(router, core, Promise.resolve(store), { error: () => {} });
  const response = { ok: ({ body }) => ({ status: 200, body }), custom: ({ statusCode, body }) => ({ status: statusCode, body }) };
  const context = { core: { opensearch: { client: { asCurrentUser: { transport: { request: async () => { throw new Error('Unavailable in test'); } } } } } } };
  const read = handlers['get /api/xdr-navigator/conversations/{id}'];
  assert.equal((await read(context, { params: { id: 'chat' }, user: 'bob' }, response)).status, 404);
  const adminRead = await read(context, { params: { id: 'chat' }, user: 'admin', roles: ['xdr_navigator_admin'] }, response);
  assert.equal(adminRead.status, 200, JSON.stringify(adminRead));
  chat.visibility = 'shared';
  assert.equal((await read(context, { params: { id: 'chat' }, user: 'bob' }, response)).status, 200);
  chat.turns.push({ id: 'turn', authorId: 'alice', authorName: 'Alice', prompt: 'Question', answer: 'Answer', status: 'done' });
  const retry = handlers['post /api/xdr-navigator/conversations/{id}/retry-last'];
  assert.equal((await retry(context, { params: { id: 'chat' }, user: 'bob' }, response)).status, 403);
  const edit = handlers['post /api/xdr-navigator/conversations/{id}/edit-last'];
  assert.equal((await edit(context, { params: { id: 'chat' }, body: { prompt: 'Changed' }, user: 'bob' }, response)).status, 403);
  const remove = handlers['delete /api/xdr-navigator/conversations/{id}'];
  assert.equal((await remove(context, { params: { id: 'chat' }, user: 'bob' }, response)).status, 403);
});

test('saving an MCP connection discovers and stores its tools', async () => {
  const remote = await serve((body) => {
    if (body.method === 'initialize') return { body: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } } };
    if (body.method === 'notifications/initialized') return { status: 202 };
    if (body.method === 'tools/list') return { body: { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search_alerts', description: 'Find alerts', inputSchema: { type: 'object', properties: {} } }] } } };
    throw new Error(`Unexpected method: ${body.method}`);
  });
  const handlers = {};
  const router = new Proxy({}, { get: (_target, method) => (config, handler) => { handlers[`${method} ${config.path}`] = handler; } });
  let saved;
  const store = { get: async () => undefined, list: async () => [], save: async (_kind, value) => { saved = value; } };
  const core = { http: { auth: { get: () => ({ status: 'authenticated', state: { authInfo: { user_id: 'admin', roles: ['xdr_navigator_admin'] } } }) } } };
  const context = { core: { opensearch: { client: { asCurrentUser: { transport: { request: async () => { throw new Error('Unavailable in test'); } } } } } } };
  const response = { ok: ({ body }) => ({ status: 200, body }), custom: ({ statusCode, body }) => ({ status: statusCode, body }) };
  registerRoutes(router, core, Promise.resolve(store), { error: () => {} });
  try {
    const result = await handlers['post /api/xdr-navigator/mcp'](context, { body: { name: 'FastMCP', url: `${remote.url}/mcp` } }, response);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(saved.tools[0].name, 'search_alerts');
    assert.ok(saved.lastDiscoveredAt);
  } finally { await remote.close(); }
});
