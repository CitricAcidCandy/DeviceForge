import { createPlatformRuntime } from '../platform-runtime.ts';
import type { PlatformRuntimeOptions } from '../platform-runtime.ts';
import { createMediaDisplay } from './media-display.ts';
import { createPluginDefaults } from '../../features/plugin-defaults/index.ts';
import { createMessageController } from '../../components/Message/index.ts';
import { createBundledDebugger } from './bundled-debugger.ts';
import type { BundledDebuggerOptions } from './bundled-debugger.ts';
import { createRouteCatalog } from './route-catalog.ts';
import { createOfficialPlugins } from '../composition/official-plugins.ts';
import type { OfficialPluginSource } from '../composition/manifest-sources.ts';
import { registerBrowserManagementServices } from '../composition/browser-management.ts';
import { bundledBrowserManagement } from '../composition/bundled-browser-management.ts';

export interface ProductConnection {
  readonly baseUrl: string;
  reconnect(baseUrl: string, token: string, signal: AbortSignal): Promise<void>;
}
export interface ProductPlatformOptions extends PlatformRuntimeOptions {
  readonly connection?: ProductConnection;
  readonly bundledDebugger?: Omit<BundledDebuggerOptions, 'runtime' | 'baseUrl'>;
  readonly officialPlugins?: {
    readonly sources: readonly OfficialPluginSource[];
    readonly persistence?: Pick<Storage, 'getItem' | 'setItem'>;
  };
}

/** 正常启动仅装配平台；业务模型和界面由实际启用的插件提供。 */
export function createProductPlatformServices(options: ProductPlatformOptions) {
  const messages = createMessageController();
  const mediaDisplay = createMediaDisplay();
  const runtime = createPlatformRuntime({
    ...options, mirroringSink: options.mirroringSink ?? mediaDisplay.sink,
  });
  const pluginDefaults = createPluginDefaults({
    packages: runtime.pluginPackages, serverPlugins: runtime.serverPlugins,
    browserPlugins: runtime.webPlugins, installations: runtime.pluginInstallations,
    signal: runtime.host.signal,
  });
  const bundledDebugger = options.bundledDebugger ? createBundledDebugger({
    ...options.bundledDebugger, runtime, baseUrl: options.baseUrl,
  }) : null;
  const officialPlugins = options.officialPlugins ? createOfficialPlugins({
    ...options.officialPlugins, runtime, baseUrl: options.baseUrl,
  }) : null;
  registerBrowserManagementServices({ host: runtime.host, extensions: runtime.webPlugins.extensions }, {
    runtime, bundled: bundledBrowserManagement({ official: officialPlugins, debugger: bundledDebugger }),
  });
  const ui = runtime.host.ui;
  const routeCatalog = ui ? createRouteCatalog({
    workspace: ui, modules: { snapshot: runtime.extensions.catalog, subscribe: runtime.extensions.subscribe },
  }) : null;
  let closing: Promise<void> | null = null;
  return {
    runtime, baseUrl: options.baseUrl, pluginConfigurations: runtime.pluginConfigurations,
    pluginDefaults, bundledDebugger, officialPlugins, routeCatalog, messages,
    client: runtime.requestClient, mediaDisplay, connection: options.connection ?? null,
    dispose(): Promise<void> {
      if (closing) return closing;
      closing = (async () => {
        const failures: unknown[] = [];
        for (const release of [pluginDefaults.dispose, () => bundledDebugger?.dispose(),
          () => officialPlugins?.dispose(), () => routeCatalog?.dispose(), messages.dispose]) {
          try { release(); } catch (error) { failures.push(error); }
        }
        const results = await Promise.allSettled([runtime.dispose(), mediaDisplay.dispose()]);
        failures.push(...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
        if (failures.length) throw new AggregateError(failures, '产品平台运行实例清理失败');
      })();
      return closing;
    },
  };
}
export type ProductPlatformServices = ReturnType<typeof createProductPlatformServices>;
