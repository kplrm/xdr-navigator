import type { PluginInitializerContext } from '../../OpenSearch-Dashboards/src/core/server';
import { XdrNavigatorServerPlugin } from './plugin';

export function plugin(context: PluginInitializerContext) {
  return new XdrNavigatorServerPlugin(context);
}
