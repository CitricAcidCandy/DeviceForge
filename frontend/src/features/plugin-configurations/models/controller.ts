import type { BrowserConfigurations } from './browser.ts';
import type { ConfigurationDefinition } from '../../../plugin-sdk/index.ts';
import type { PluginConfigurationController, PluginConfigurationTarget } from '../types/index.ts';

export function createPluginConfigurations(options: {
  readonly server: PluginConfigurationController;
  readonly browser: BrowserConfigurations;
  readonly inspectBrowser: (
    id: string,
    signal: AbortSignal,
  ) => Promise<ConfigurationDefinition | null>;
  readonly reloadBrowser: (id: string, signal: AbortSignal) => Promise<void>;
}): PluginConfigurationController {
  async function inspect(target: PluginConfigurationTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    const definition = await options.inspectBrowser(target.id, signal);
    signal.throwIfAborted();
    options.browser.define(target.id, definition);
  }
  return {
    async get(target, signal) {
      if (target.kind === 'server') return options.server.get(target, signal);
      await inspect(target, signal);
      return options.browser.get(target.id, signal);
    },
    async save(target, revision, values, signal) {
      if (target.kind === 'server') return options.server.save(target, revision, values, signal);
      signal.throwIfAborted();
      return options.browser.save(target.id, revision, values, signal);
    },
    async reset(target, revision, signal) {
      if (target.kind === 'server') return options.server.reset(target, revision, signal);
      signal.throwIfAborted();
      return options.browser.reset(target.id, revision, signal);
    },
    async apply(target, revision, signal) {
      if (target.kind === 'server') return options.server.apply(target, revision, signal);
      signal.throwIfAborted();
      return options.browser.apply(target.id, revision, signal, (current) =>
        options.reloadBrowser(target.id, current),
      );
    },
  };
}
