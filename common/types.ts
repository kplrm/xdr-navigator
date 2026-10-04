export type Visibility = 'private' | 'shared';

export interface ModelConnection {
  id: string;
  name: string;
  url: string;
  model: string;
  apiKey?: string;
  hasApiKey?: boolean;
}

export interface McpConnection {
  id: string;
  name: string;
  url: string;
  authToken?: string;
  hasAuthToken?: boolean;
  tools: McpTool[];
  lastDiscoveredAt?: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface NavigatorAgent {
  id: string;
  name: string;
  description: string;
  systemContext: string;
  toolKeys: string[];
  builtIn?: boolean;
}

export interface RunStep {
  id: string;
  kind: 'model' | 'tool' | 'reasoning';
  title: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  input?: unknown;
  output?: unknown;
  startedAt: string;
  completedAt?: string;
}

export interface ConversationTurn {
  id: string;
  authorId: string;
  authorName: string;
  prompt: string;
  answer: string;
  modelId: string;
  agentId: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  steps: RunStep[];
  createdAt: string;
}

export interface Conversation {
  id: string;
  ownerId: string;
  ownerName: string;
  title: string;
  visibility: Visibility;
  modelId: string;
  agentId: string;
  turns: ConversationTurn[];
  createdAt: string;
  updatedAt: string;
}
