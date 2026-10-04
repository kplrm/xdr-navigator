import React, { useCallback, useEffect, useState } from 'react';
import { Conversation, ConversationTurn, McpConnection, ModelConnection, NavigatorAgent } from '../common/types';
import { Api, ConversationSummary, Session } from './api';

interface Props { api: Api; mode: 'page' | 'sidecar'; initialConversationId?: string; onSelectChat: (id?: string) => void; onClose?: () => void }
type Section = 'Conversations' | 'Models' | 'Agents' | 'MCP servers';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function NavigatorApp({ api, mode, initialConversationId, onSelectChat, onClose }: Props) {
  const [section, setSection] = useState<Section>('Conversations');
  const [session, setSession] = useState<Session>();
  const [models, setModels] = useState<ModelConnection[]>([]);
  const [agents, setAgents] = useState<NavigatorAgent[]>([]);
  const [servers, setServers] = useState<McpConnection[]>([]);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try {
      const [s, m, a, p] = await Promise.all([api.session(), api.models(), api.agents(), api.mcps()]);
      setSession(s); setModels(m); setAgents(a); setServers(p); setError('');
    } catch (e) { setError(message(e)); }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (mode === 'page' && session?.user.admin) setSection('Models'); }, [mode, session?.user.admin]);

  if (mode === 'sidecar') return <div className="xdrNav xdrNav--sidecar">
    <header className="xdrNavSidecarHeader"><strong>XDR Navigator</strong><button aria-label="Close XDR Navigator" title="Close chat" onClick={onClose}>×</button></header>
    {error && <div className="xdrNavError">{error}</div>}
    {!session && error ? <div className="xdrNavAuthRequired">Sign in to use XDR Navigator. OpenSearch Security must be enabled.</div> :
      <ChatPanel api={api} session={session} models={models} agents={agents} initialConversationId={initialConversationId} onSelectChat={onSelectChat} />}
  </div>;

  return <div className="xdrNav xdrNav--page">
    <header className="xdrNavPageHeader"><div><h1>XDR Navigator</h1><p>Manage model connections, AI agents, MCP tools, and conversations</p></div></header>
    {error && <div className="xdrNavError">{error}</div>}
    {!session ? <div className="xdrNavAuthRequired">Sign in to manage Navigator. OpenSearch Security must be enabled.</div> : <>
      <nav className="xdrNavTabs" aria-label="Navigator settings">
        {(['Conversations', ...(session.user.admin ? ['Models', 'Agents', 'MCP servers'] : [])] as Section[]).map((item) =>
          <button key={item} className={item === section ? 'active' : ''} onClick={() => setSection(item)}>{item === 'Models' ? 'Model connections' : item === 'Agents' ? 'AI agents' : item}</button>)}
      </nav>
      {section === 'Conversations' && <ConversationsPanel api={api} session={session} onOpenChat={(id) => onSelectChat(id)} />}
      {section === 'Models' && session.user.admin && <ModelsPanel api={api} models={models} reload={reload} encryptionReady={session.encryptionReady} />}
      {section === 'Agents' && session.user.admin && <AgentsPanel api={api} agents={agents} servers={servers} reload={reload} />}
      {section === 'MCP servers' && session.user.admin && <McpPanel api={api} servers={servers} reload={reload} encryptionReady={session.encryptionReady} />}
    </>}
  </div>;
}

function ConversationsPanel({ api, session, onOpenChat }: { api: Api; session: Session; onOpenChat: (id: string) => void }) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setItems(await api.conversations()); setError(''); }
    catch (e) { setError(message(e)); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const update = async (path: string, method: string, body?: unknown) => {
    try { await api.call(path, method, body); await refresh(); }
    catch (e) { setError(message(e)); }
  };
  return <section className="xdrNavManage"><h2>Conversations</h2><p>Open a conversation in the AI panel or manage its access and retention.</p>
    {error && <div className="xdrNavError">{error}</div>}
    {!items.length ? <div className="xdrNavEmptyList">No conversations yet. Open XDR AI Agent in the top-right corner to start one.</div> :
      <div className="xdrNavConversationList">{items.map((item) => {
        const canManage = session.user.admin || session.user.id === item.ownerId;
        return <article key={item.id} className="xdrNavConversationCard">
          <div><strong>{item.title}</strong><small>{item.ownerName} · {item.turnCount} messages · {new Date(item.updatedAt).toLocaleString()}</small></div>
          <div className="xdrNavConversationCardActions">
            <button onClick={() => onOpenChat(item.id)}>Open chat</button>
            {canManage ? <select aria-label={`Access for ${item.title}`} value={item.visibility} onChange={(event) => void update(`/conversations/${item.id}/visibility`, 'PUT', { visibility: event.target.value })}><option value="private">Private</option><option value="shared">Shared</option></select> : <span className="xdrNavBadge">Shared</span>}
            {canManage && <button className="xdrNavDanger" onClick={() => { if (window.confirm('Delete this entire conversation?')) void update(`/conversations/${item.id}`, 'DELETE'); }}>Delete</button>}
          </div>
        </article>;
      })}</div>}
  </section>;
}

function ChatPanel({ api, session, models, agents, initialConversationId, onSelectChat }: {
  api: Api; session?: Session; models: ModelConnection[]; agents: NavigatorAgent[]; initialConversationId?: string; onSelectChat: (id?: string) => void;
}) {
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [chat, setChat] = useState<Conversation>();
  const [selectedId, setSelectedId] = useState<string | undefined>(initialConversationId);
  const [modelId, setModelId] = useState('');
  const [agentId, setAgentId] = useState('xdr-ai-agent');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const list = await api.conversations(); setSummaries(list);
      if (selectedId) {
        const latest = await api.conversation(selectedId);
        setChat(latest);
      }
    } catch (e) { setError(message(e)); }
  }, [api, selectedId]);
  useEffect(() => { setSelectedId(initialConversationId); }, [initialConversationId]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1800); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => { if (!modelId && models[0]) setModelId(models[0].id); }, [models, modelId]);
  useEffect(() => { if (!agents.some((a) => a.id === agentId) && agents[0]) setAgentId(agents[0].id); }, [agents, agentId]);
  useEffect(() => { if (chat) { setModelId(chat.modelId); setAgentId(chat.agentId); } }, [chat?.id]);
  const select = (id?: string) => {
    setSelectedId(id); setChat(undefined); setDraft(''); setEditing(false); setError(''); onSelectChat(id);
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await refresh(); } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const send = () => void action(async () => {
    if (!draft.trim()) return;
    let id = chat?.id;
    if (!id) {
      const created = await api.call<Conversation>('/conversations', 'POST', { modelId, agentId });
      id = created.id; select(id);
    }
    if (editing) {
      await api.call(`/conversations/${id}/edit-last`, 'POST', { prompt: draft.trim() });
    } else {
      await api.call(`/conversations/${id}/turns`, 'POST', { prompt: draft.trim(), modelId, agentId });
    }
    setDraft(''); setEditing(false); setSelectedId(id); onSelectChat(id);
  });
  const latest = chat?.turns[chat.turns.length - 1];
  const canOwn = Boolean(session && chat && (session.user.admin || session.user.id === chat.ownerId));
  const canChangeLast = Boolean(session && latest && latest.status !== 'running' && (session.user.admin || session.user.id === latest.authorId));
  const running = latest?.status === 'running';
  return <div className="xdrNavChatLayout">
    <aside className="xdrNavHistory">
      <button className="xdrNavPrimary xdrNavNew" onClick={() => select()}>+ New chat</button>
      {summaries.map((item) => <button key={item.id} className={`xdrNavHistoryItem ${selectedId === item.id ? 'active' : ''}`} onClick={() => select(item.id)}>
        <strong>{item.title}</strong><small>{item.visibility === 'shared' ? 'Shared' : 'Private'} · {item.ownerName}</small>
      </button>)}
    </aside>
    <main className="xdrNavConversation">
      <div className="xdrNavConversationHeader">
        <div><strong>{chat?.title || 'New conversation'}</strong><small>{chat ? `Created by ${chat.ownerName}` : 'Choose a model and an agent to start'}</small></div>
        {chat && <div className="xdrNavActions">
          {canOwn && <select value={chat.visibility} aria-label="Conversation visibility" onChange={(event) => void action(async () => { await api.call(`/conversations/${chat.id}/visibility`, 'PUT', { visibility: event.target.value }); })}>
            <option value="private">Private</option><option value="shared">Shared</option>
          </select>}
          {!canOwn && <span className="xdrNavBadge">{chat.visibility}</span>}
          {canOwn && <button className="xdrNavDanger" onClick={() => { if (window.confirm('Delete this entire conversation?')) void action(async () => { await api.call(`/conversations/${chat.id}`, 'DELETE'); select(); }); }}>Delete</button>}
        </div>}
      </div>
      <div className="xdrNavTurns">
        {!chat?.turns.length && <div className="xdrNavEmpty"><div className="xdrNavSpark">✦</div><h2>Ask XDR AI Agent</h2><p>Start an investigation or ask a question.</p></div>}
        {chat?.turns.map((turn) => <Turn key={turn.id} turn={turn} />)}
      </div>
      <div className="xdrNavComposer">
        {error && <div className="xdrNavError">{error}</div>}
        {canChangeLast && <div className="xdrNavTurnActions">
          <button onClick={() => { setDraft(latest!.prompt); setEditing(true); }}>Edit last message</button>
          <button disabled={busy} onClick={() => void action(async () => { await api.call(`/conversations/${chat!.id}/retry-last`, 'POST'); })}>Retry last message</button>
        </div>}
        {editing && <div className="xdrNavEditing">Editing your last message <button onClick={() => { setEditing(false); setDraft(''); }}>Cancel</button></div>}
        <textarea aria-label="Ask anything" placeholder="Ask anything" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} />
        <div className="xdrNavComposerBottom">
          <select aria-label="Model connection" value={modelId} onChange={(event) => setModelId(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select>
          <select aria-label="AI agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <button className="xdrNavPrimary" disabled={busy || running || !draft.trim() || !modelId || !agentId} onClick={send}>{editing ? 'Resend' : 'Send'}</button>
        </div>
      </div>
    </main>
  </div>;
}

function Turn({ turn }: { turn: ConversationTurn }) {
  return <article className="xdrNavTurn">
    <div className="xdrNavPrompt"><small>{turn.authorName}</small><p>{turn.prompt}</p></div>
    <div className="xdrNavAnswer">
      {turn.steps.map((step) => <details key={step.id} className="xdrNavStep">
        <summary><span>{step.kind === 'tool' ? '⚙' : '✦'} {step.title}</span><em>{step.status}</em></summary>
        {step.detail && <p>{step.detail}</p>}
        {step.input !== undefined && <pre>Parameters: {JSON.stringify(step.input, null, 2)}</pre>}
        {step.output !== undefined && <pre>Result: {JSON.stringify(step.output, null, 2)}</pre>}
      </details>)}
      {turn.answer && <p className="xdrNavAnswerText">{turn.answer}</p>}
      {turn.status === 'running' && <p className="xdrNavWorking">Working…</p>}
      {turn.error && <p className="xdrNavError">{turn.error}</p>}
    </div>
  </article>;
}

function ModelsPanel({ api, models, reload, encryptionReady }: { api: Api; models: ModelConnection[]; reload: () => Promise<void>; encryptionReady: boolean }) {
  const [form, setForm] = useState({ id: '', name: '', url: '', model: '', apiKey: '' });
  const [status, setStatus] = useState('');
  const run = async (path: string, method: string, body?: unknown) => { try { await api.call(path, method, body); setStatus('Saved successfully'); await reload(); } catch (e) { setStatus(message(e)); } };
  return <section className="xdrNavManage"><h2>Model connections</h2><p>OpenAI-compatible chat-completions endpoints. API keys stay on the Navigator server.</p>
    <div className="xdrNavManageGrid"><div className="xdrNavList">{models.map((item) => <button key={item.id} onClick={() => { setForm({ id: item.id, name: item.name, url: item.url, model: item.model, apiKey: '' }); setStatus(''); }}><strong>{item.name}</strong><small>{item.model} · {item.hasApiKey ? 'API key saved' : 'No API key'}</small></button>)}<button onClick={() => setForm({ id: '', name: '', url: '', model: '', apiKey: '' })}>+ Add connection</button></div>
      <div className="xdrNavForm"><label>Unique name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Chat-completions URL<input placeholder="https://api.example.com/v1/chat/completions" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></label>
        <label>Default model<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
        <label>API key<input type="password" placeholder={form.id ? 'Leave blank to keep saved key' : 'Optional for local models'} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></label>
        {!encryptionReady && <p className="xdrNavError">Set XDR_NAVIGATOR_ENCRYPTION_KEY before saving credentials.</p>}
        <div className="xdrNavFormActions"><button onClick={async () => { try { const result = await api.call<{ response: string }>('/models/test', 'POST', form); setStatus(`Connection works: ${result.response}`); } catch (e) { setStatus(message(e)); } }}>Test</button>
          <button className="xdrNavPrimary" onClick={() => void run('/models', 'POST', form)}>Save</button>
          {form.id && <button className="xdrNavDanger" onClick={() => { if (window.confirm('Delete this model connection?')) void run(`/models/${form.id}`, 'DELETE'); }}>Delete</button>}</div>
        {status && <p>{status}</p>}
      </div></div>
  </section>;
}

function McpPanel({ api, servers, reload, encryptionReady }: { api: Api; servers: McpConnection[]; reload: () => Promise<void>; encryptionReady: boolean }) {
  const [form, setForm] = useState({ id: '', name: '', url: '', authToken: '' });
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState<McpConnection['tools']>([]);
  const run = async (path: string, method: string, body?: unknown) => { try { await api.call(path, method, body); setStatus('Saved successfully'); await reload(); } catch (e) { setStatus(message(e)); } };
  return <section className="xdrNavManage"><h2>MCP servers</h2><p>Connect to a FastMCP container or another Streamable HTTP endpoint, then discover its tools.</p>
    <div className="xdrNavManageGrid"><div className="xdrNavList">{servers.map((item) => <button key={item.id} onClick={() => { setForm({ id: item.id, name: item.name, url: item.url, authToken: '' }); setPreview(item.tools); setStatus(''); }}><strong>{item.name}</strong><small>{item.tools.length} tools · {item.url}</small></button>)}<button onClick={() => { setForm({ id: '', name: '', url: '', authToken: '' }); setPreview([]); }}>+ Add server</button></div>
      <div className="xdrNavForm"><label>Unique name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>MCP URL<input placeholder="http://fastmcp:8000/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></label>
        <label>Bearer token<input type="password" placeholder={form.id ? 'Leave blank to keep saved token' : 'Optional'} value={form.authToken} onChange={(e) => setForm({ ...form, authToken: e.target.value })} /></label>
        {!encryptionReady && <p className="xdrNavError">Set XDR_NAVIGATOR_ENCRYPTION_KEY before saving credentials.</p>}
        <div className="xdrNavFormActions"><button onClick={async () => { try { const result = await api.call<{ tools: McpConnection['tools'] }>('/mcp/test', 'POST', form); setPreview(result.tools); setStatus(`Discovered ${result.tools.length} tools`); } catch (e) { setStatus(message(e)); } }}>Test discovery</button>
          <button className="xdrNavPrimary" onClick={() => void run('/mcp', 'POST', form)}>Save</button>
          {form.id && <button onClick={() => void run(`/mcp/${form.id}/refresh`, 'POST')}>Refresh tools</button>}
          {form.id && <button className="xdrNavDanger" onClick={() => { if (window.confirm('Delete this MCP server?')) void run(`/mcp/${form.id}`, 'DELETE'); }}>Delete</button>}</div>
        {status && <p>{status}</p>}
        <div className="xdrNavTools">{preview.map((tool) => <div key={tool.name}><strong>{tool.name}</strong><p>{tool.description}</p></div>)}</div>
      </div></div>
  </section>;
}

function AgentsPanel({ api, agents, servers, reload }: { api: Api; agents: NavigatorAgent[]; servers: McpConnection[]; reload: () => Promise<void> }) {
  const [form, setForm] = useState<NavigatorAgent>({ id: '', name: '', description: '', systemContext: '', toolKeys: [] });
  const [status, setStatus] = useState('');
  const setTool = (key: string, checked: boolean) => setForm({ ...form, toolKeys: checked ? [...form.toolKeys, key] : form.toolKeys.filter((item) => item !== key) });
  return <section className="xdrNavManage"><h2>AI agents</h2><p>Edit each agent’s system context and assign discovered MCP tools.</p>
    <div className="xdrNavManageGrid"><div className="xdrNavList">{agents.map((item) => <button key={item.id} onClick={() => { setForm({ ...item }); setStatus(''); }}><strong>{item.name}</strong><small>{item.toolKeys.length} tools · {item.description}</small></button>)}<button onClick={() => setForm({ id: '', name: '', description: '', systemContext: '', toolKeys: [] })}>+ Add agent</button></div>
      <div className="xdrNavForm"><label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Description<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label>System context<textarea rows={10} value={form.systemContext} onChange={(e) => setForm({ ...form, systemContext: e.target.value })} /></label>
        <div className="xdrNavToolPicker"><strong>Assigned tools</strong>{servers.flatMap((server) => server.tools.map((tool) => { const key = `${server.id}:${tool.name}`; return <label key={key}><input type="checkbox" checked={form.toolKeys.includes(key)} onChange={(e) => setTool(key, e.target.checked)} /><span><strong>{server.name} · {tool.name}</strong><small>{tool.description}</small></span></label>; }))}</div>
        <div className="xdrNavFormActions"><button className="xdrNavPrimary" onClick={async () => { try { await api.call('/agents', 'POST', form); setStatus('Agent saved'); await reload(); } catch (e) { setStatus(message(e)); } }}>Save</button>
          {form.id && !form.builtIn && <button className="xdrNavDanger" onClick={async () => { if (!window.confirm('Delete this agent?')) return; try { await api.call(`/agents/${form.id}`, 'DELETE'); setStatus('Agent deleted'); await reload(); } catch (e) { setStatus(message(e)); } }}>Delete</button>}</div>
        {status && <p>{status}</p>}
      </div></div>
  </section>;
}
