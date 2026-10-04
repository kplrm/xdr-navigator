import { McpConnection, McpTool } from '../common/types';
import { unseal } from './security';

interface McpSession { id?: string; protocol: string }

async function request(server: McpConnection, session: McpSession, method: string, params?: unknown): Promise<unknown> {
  const url = new URL(server.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('MCP endpoint must be an HTTP(S) URL without embedded credentials');
  }
  const token = unseal(server.authToken);
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: (AbortSignal as any).timeout(30000),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': session.protocol,
      ...(session.id ? { 'mcp-session-id': session.id } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, ...(params === undefined ? {} : { params }) }),
  });
  if (response.headers.get('mcp-session-id')) session.id = response.headers.get('mcp-session-id') || undefined;
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP server returned ${response.status}: ${raw.slice(0, 300)}`);
  let message: any;
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
    message = data.map((part) => { try { return JSON.parse(part); } catch { return undefined; } }).find((item) => item?.result || item?.error);
  } else if (raw) {
    try { message = JSON.parse(raw); } catch { throw new Error('MCP server returned invalid JSON'); }
  }
  if (message?.error) throw new Error(`MCP error: ${message.error.message || 'unknown error'}`);
  return message?.result;
}

async function connect(server: McpConnection): Promise<McpSession> {
  const session: McpSession = { protocol: '2025-11-25' };
  const result = await request(server, session, 'initialize', {
    protocolVersion: session.protocol,
    capabilities: {},
    clientInfo: { name: 'xdr-navigator', version: '0.1.0' },
  }) as { protocolVersion?: string };
  if (result?.protocolVersion) session.protocol = result.protocolVersion;
  const token = unseal(server.authToken);
  const response = await fetch(server.url, {
    method: 'POST', redirect: 'error', signal: (AbortSignal as any).timeout(30000),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': session.protocol,
      ...(session.id ? { 'mcp-session-id': session.id } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  if (!response.ok) throw new Error(`MCP initialization failed: ${response.status}`);
  return session;
}

export async function discoverTools(server: McpConnection): Promise<McpTool[]> {
  const session = await connect(server);
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const result = await request(server, session, 'tools/list', cursor ? { cursor } : {}) as { tools?: McpTool[]; nextCursor?: string };
    tools.push(...(result?.tools || []).map((tool) => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || { type: 'object', properties: {} } })));
    cursor = result?.nextCursor;
  } while (cursor);
  return tools;
}

export async function callTool(server: McpConnection, name: string, args: unknown): Promise<unknown> {
  const session = await connect(server);
  const result = await request(server, session, 'tools/call', { name, arguments: args }) as { isError?: boolean; content?: unknown; structuredContent?: unknown };
  if (result?.isError) throw new Error(JSON.stringify(result.content).slice(0, 500));
  return result?.structuredContent ?? result?.content ?? result;
}
