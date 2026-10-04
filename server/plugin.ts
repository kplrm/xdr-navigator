import type { CoreSetup, CoreStart, ISavedObjectsRepository, Logger, Plugin, PluginInitializerContext } from '../../OpenSearch-Dashboards/src/core/server';
import { registerRoutes } from './routes';
import { registerTypes, Store, TYPES } from './store';

export class XdrNavigatorServerPlugin implements Plugin<Record<string, never>, Record<string, never>> {
  private logger: Logger;
  private resolveStore!: (value: Store) => void;
  private storePromise = new Promise<Store>((resolve) => { this.resolveStore = resolve; });

  constructor(context: PluginInitializerContext) { this.logger = context.logger.get(); }

  public setup(core: CoreSetup) {
    registerTypes(core);
    registerRoutes(core.http.createRouter(), core, this.storePromise, this.logger);
    return {};
  }

  public start(core: CoreStart) {
    const repo: ISavedObjectsRepository = core.savedObjects.createInternalRepository(Object.values(TYPES));
    const store = new Store(repo);
    void (async () => {
      if (!await store.get('agent', 'xdr-ai-agent')) {
        await store.save('agent', {
          id: 'xdr-ai-agent', name: 'XDR AI Agent', description: 'General XDR investigation assistant', builtIn: true,
          systemContext: 'You are XDR AI Agent. Help analysts investigate security events. Use assigned tools when they are relevant. Describe findings accurately, distinguish evidence from inference, and state when data is unavailable.',
          toolKeys: [],
        });
      }
    })().catch((error) => this.logger.error(`xdr-navigator default agent setup failed: ${error}`))
      .finally(() => this.resolveStore(store));
    return {};
  }

  public stop() {}
}
