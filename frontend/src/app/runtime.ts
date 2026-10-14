import { browserPackageEntryUrl, createApiClient, createMcpTransport, uploadEndpoint } from '../services/api/index.ts';
import type { ClientOptions } from '../services/api/index.ts';
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
import { createCatalogRefresh } from './catalog-refresh.ts';
import { createDomThemeAdapter } from '../plugins/themes/dom.ts';
import { createHttpAiSdkStreaming } from '../features/ai-sdk-streaming/index.ts';
import { registerAiSdkStreamingService } from './ai-sdk-streaming-service.ts';
import { createHttpAiSdk } from '../features/ai-sdk/index.ts';
import { registerAiSdkService } from './ai-sdk-service.ts';
import { createMcpClient } from '../features/mcp/index.ts';
import { createHttpPerformance } from '../features/performance/index.ts';
import { registerPerformanceService } from './performance-service.ts';
import { createHttpMirroringStreaming } from '../features/mirroring-streaming/index.ts';
import type { MirroringStreamSink } from '../features/mirroring-streaming/index.ts';
import { registerMirroringStreamingService } from './mirroring-streaming-service.ts';

export interface RuntimeOptions extends ClientOptions {
  readonly panelTarget: ManagerOptions['panelTarget'];
  readonly componentTarget?: ManagerOptions['componentTarget'];
  readonly moduleTarget?: ManagerOptions['moduleTarget'];
  readonly esmImporter?: EsmImporter;
  readonly packageEntryResolver?: PackageEntryResolver;
  readonly slotAdapter?: ManagerOptions['slotAdapter'];
  readonly themeTarget?: HTMLElement;
  readonly mirroringSink?: MirroringStreamSink;
}
export function createFrontendRuntime(options: RuntimeOptions) {
  const lifetime = new AbortController();
  const client = createApiClient(options);
  const mcp = createMcpClient(createMcpTransport(options));
  const aiSdk = createHttpAiSdk(client);
  const aiSdkStreaming = createHttpAiSdkStreaming(client);
  const performance = createHttpPerformance(client);
  const mirroringStreaming = createHttpMirroringStreaming(client, options.mirroringSink ? { sink: options.mirroringSink } : {});
  const operations = createOperations(client);
  const extensions = createExtensionRegistry(options.themeTarget ? createDomThemeAdapter(options.themeTarget) : undefined);
  const tasks = createTasks(client, extensions.beforeTaskSubmit);
  const devices = createDevices(createDeviceGateway(client, lifetime.signal));
  const artifacts = {
    upload: (filename: string, content: Blob, signal: AbortSignal) => client.call(uploadEndpoint, { filename, content }, AbortSignal.any([signal, lifetime.signal])),
    download: (id: string, signal: AbortSignal) => client.downloadArtifact(id, AbortSignal.any([signal, lifetime.signal])),
  };
  const host = createHostContext(operations, tasks, lifetime, devices, artifacts, tasks);
  host.context.onDispose(registerAiSdkService(extensions, host.context, aiSdk));
  host.context.onDispose(registerAiSdkStreamingService(extensions, host.context, aiSdkStreaming));
  host.context.onDispose(registerPerformanceService(extensions, host.context, performance));
  host.context.onDispose(registerMirroringStreamingService(extensions, host.context, mirroringStreaming));
  const themes = extensions.themeAccess(host.context);
  const context = Object.freeze<HostContext>({ ...host.context, extensions: extensions.hostAccess(host.context), themes });
  const serverPlugins = createServerPlugins(client, createCatalogRefresh(operations.refresh, devices, operations.invalidate));
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
    themes,
    extensions: {
      catalog: extensions.catalog,
      executeCommand: extensions.executeCommand,
      callService: extensions.callService,
      mountComponent: webPlugins.mountComponent,
      mountModule: webPlugins.mountModule,
      unmount: webPlugins.unmountExtension,
    },
    registerInstalledPackage: browserPackages.register,
    artifacts,
    aiSdk,
    aiSdkStreaming,
    performance,
    mirroringStreaming,
    mcp,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      lifetime.abort();
      aiSdk.dispose();
      aiSdkStreaming.dispose();
      performance.dispose();
      operations.dispose(); tasks.dispose(); devices.dispose(); serverPlugins.dispose(); pluginPackages.dispose();
      disposal = (async () => {
        const results = await Promise.allSettled([webPlugins.dispose(), host.dispose(), mcp.dispose(), Promise.resolve().then(() => mirroringStreaming.dispose())]);
        extensions.dispose();
        browserPackages.clearSources();
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '前端运行实例关闭失败');
      })();
      return disposal;
    },
  };
}
