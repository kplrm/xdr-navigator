import type { CoreStart } from '../../OpenSearch-Dashboards/src/core/public';
import { Conversation, McpConnection, ModelConnection, NavigatorAgent } from '../common/types';

export interface Session { user: { id: string; name: string; admin: boolean }; encryptionReady: boolean }
export interface ConversationSummary extends Omit<Conversation, 'turns'> { turnCount: number }

export class Api {
  constructor(private core: CoreStart) {}
  async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    try {
      return await this.core.http.fetch<T>(`/api/xdr-navigator${path}`, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const detail = (error as { body?: { message?: unknown } })?.body?.message;
      if (typeof detail === 'string') throw new Error(detail);
      throw error;
    }
  }
  session() { return this.call<Session>('/session'); }
  models() { return this.call<ModelConnection[]>('/models'); }
  mcps() { return this.call<McpConnection[]>('/mcp'); }
  agents() { return this.call<NavigatorAgent[]>('/agents'); }
  conversations() { return this.call<ConversationSummary[]>('/conversations'); }
  conversation(id: string) { return this.call<Conversation>(`/conversations/${encodeURIComponent(id)}`); }
}
