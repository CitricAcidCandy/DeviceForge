import { browserPackageEntryUrl, createApiClient, uploadEndpoint } from '../shared/api/index.ts';
import type { ClientOptions } from '../shared/api/index.ts';
import { createOperations } from '../features/operations/index.ts';
import { createTasks } from '../features/tasks/index.ts';
import { createServerPlugins } from '../features/server-plugins/index.ts';
import { createExtensionRegistry, createInstalledPackageController, createPluginManager } from '../plugins/index.ts';
import type { ManagerOptions } from '../plugins/index.ts';
import type { EsmImporter, HostContext, PackageEntryResolver } from '../plugin-sdk/index.ts';
import { createHostContext } from './host-context.ts';
import { createPluginPackages } from '../features/plugin-packages/index.ts';
import { createDevices } from '../features/devices/index.ts';
import { createDeviceGateway } from './device-gateway.ts';

export interface RuntimeOptions extends ClientOptions {
  readonly panelTarget: ManagerOptions['panelTarget'];
  readonly componentTarget?: ManagerOptions['componentTarget'];
  readonly moduleTarget?: ManagerOptions['moduleTarget'];
  readonly esmImporter?: EsmImporter;
  readonly packageEntryResolver?: PackageEntryResolver;
  readonly slotAdapter?: ManagerOptions['slotAdapter'];
}
export function createFrontendRuntime(options: RuntimeOptions) {
  const lifetime = new AbortController();
  const client = createApiClient(options);
  const operations = createOperations(client);
  const extensions = createExtensionRegistry();
  const tasks = createTasks(client, extensions.beforeTaskSubmit);
  const devices = createDevices(createDeviceGateway(client, lifetime.signal));
  const host = createHostContext(operations, tasks, lifetime, devices);
  const context = Object.freeze<HostContext>({ ...host.context, extensions: extensions.hostAccess(host.context) });
  const serverPlugins = createServerPlugins(client, operations.refresh);
  const webPlugins = createPluginManager({ host: context, panelTarget: options.panelTarget, extensionRegistry: extensions,
    ...(options.componentTarget ? { componentTarget: options.componentTarget } : {}),
    ...(options.moduleTarget ? { moduleTarget: options.moduleTarget } : {}),
    ...(options.slotAdapter ? { slotAdapter: options.slotAdapter } : {}),
  });
  const resolveEntry: PackageEntryResolver = options.packageEntryResolver ?? ((descriptor, runId) => browserPackageEntryUrl(options.baseUrl, { id: descriptor.id, run_id: runId, path: descriptor.entryPath }));
  const browserPackages = createInstalledPackageController(webPlugins, resolveEntry, options.esmImporter);
  const pluginPackages = createPluginPackages(client, {
    enableServer: serverPlugins.load,
    disableServer: serverPlugins.unload,
    async prepareServerRemoval(id, signal) {
      const running = await serverPlugins.refresh(signal);
      if (running.data.some((plugin) => plugin.id === id)) await serverPlugins.unload(id, signal);
    },
    enableBrowser: (pkg, signal) => browserPackages.enable({ id: pkg.id, version: pkg.version, entryPath: pkg.entry_path }, signal),
    disableBrowser: browserPackages.disable,
    forgetBrowser: browserPackages.forget,
  });
  let lastOperations: unknown = null;
  host.context.onDispose(operations.subscribe((snapshot) => {
    if (!snapshot.result || snapshot.result.data === lastOperations || lifetime.signal.aborted) return;
    lastOperations = snapshot.result.data;
    context.extensions?.emitEvent('host.operations.changed', snapshot.result.data.map((entry) => entry.id));
  }));
  let disposal: Promise<void> | null = null;
  return {
    host: context,
    operations,
    tasks,
    devices,
    serverPlugins,
    pluginPackages,
    webPlugins,
    extensions: {
      catalog: extensions.catalog,
      executeCommand: extensions.executeCommand,
      callService: extensions.callService,
      mountComponent: webPlugins.mountComponent,
      mountModule: webPlugins.mountModule,
      unmount: webPlugins.unmountExtension,
    },
    registerInstalledPackage: browserPackages.register,
    artifacts: {
      upload: (filename: string, content: Blob, signal: AbortSignal) => client.call(uploadEndpoint, { filename, content }, AbortSignal.any([signal, lifetime.signal])),
      download: (id: string, signal: AbortSignal) => client.downloadArtifact(id, AbortSignal.any([signal, lifetime.signal])),
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      lifetime.abort();
      operations.dispose(); tasks.dispose(); devices.dispose(); serverPlugins.dispose(); pluginPackages.dispose();
      disposal = (async () => {
        const results = await Promise.allSettled([webPlugins.dispose(), host.dispose()]);
        extensions.dispose();
        browserPackages.clearSources();
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '前端运行实例关闭失败');
      })();
      return disposal;
    },
  };
}
