import { randomUUID } from 'crypto';
import type { ISavedObjectsRepository, CoreSetup } from '../../OpenSearch-Dashboards/src/core/server';
import { Conversation, McpConnection, ModelConnection, NavigatorAgent } from '../common/types';

export const TYPES = {
  model: 'xdr-nav-model',
  mcp: 'xdr-nav-mcp',
  agent: 'xdr-nav-agent',
  conversation: 'xdr-nav-conversation',
} as const;

type Kind = keyof typeof TYPES;
type Document = ModelConnection | McpConnection | NavigatorAgent | Conversation;

export function registerTypes(core: CoreSetup) {
  for (const name of Object.values(TYPES)) {
    core.savedObjects.registerType({
      name,
      hidden: true,
      namespaceType: 'agnostic',
      mappings: { properties: {
        name: { type: 'keyword' },
        payload: { type: 'object', enabled: false },
      } },
    });
  }
}

export class Store {
  constructor(private repo: ISavedObjectsRepository) {}

  async list<T extends Document>(kind: Kind): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const found = await this.repo.find<{ name: string; payload: T }>({ type: TYPES[kind], perPage: 1000, page });
      items.push(...found.saved_objects.map((object) => ({ ...object.attributes.payload, id: object.id })));
      if (items.length >= found.total || found.saved_objects.length === 0) return items;
    }
  }

  async get<T extends Document>(kind: Kind, id: string): Promise<T | undefined> {
    try {
      const object = await this.repo.get<{ name: string; payload: T }>(TYPES[kind], id);
      return { ...object.attributes.payload, id: object.id };
    } catch (error) {
      if ((error as { output?: { statusCode?: number } }).output?.statusCode === 404) return undefined;
      throw error;
    }
  }

  async save<T extends Document>(kind: Kind, document: T): Promise<T> {
    const id = document.id || randomUUID();
    const value = { ...document, id };
    const display = value as { name?: string; title?: string };
    await this.repo.create(TYPES[kind], {
      name: display.name || display.title || id,
      payload: value,
    }, { id, overwrite: true });
    return value;
  }

  async delete(kind: Kind, id: string): Promise<void> {
    await this.repo.delete(TYPES[kind], id);
  }
}
