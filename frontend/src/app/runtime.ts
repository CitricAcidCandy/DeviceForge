import {
  browserPackageEntryUrl,
  createApiClient,
  createMcpTransport,
  uploadEndpoint,
  uploadInstallationArtifactEndpoint,
  ApiError,
} from '../services/api/index.ts';
import type { ClientOptions } from '../services/api/index.ts';
import { createOperations } from '../features/operations/index.ts';
import { createTasks } from '../features/tasks/index.ts';
import { createServerPlugins } from '../features/server-plugins/index.ts';
import { createPluginDependenciesHttp } from '../features/plugin-dependencies/index.ts';
import {
  createExtensionRegistry,
  createInstalledPackageController,
  createPluginManager,
} from '../plugins/index.ts';
import type { ManagerOptions } from '../plugins/index.ts';
import type {
  EsmImporter,
  HostContext,
  PackageEntryResolver,
  SlotAdapter,
  SlotHost,
} from '../plugin-sdk/index.ts';
import { createHostContext } from './host-context.ts';
import { createReleaseHost } from './release-host.ts';
import { createServerServiceAccess } from './server-services.ts';
import { createReleaseRequestClient } from './release-requests.ts';
import { createPluginPackages } from '../features/plugin-packages/index.ts';
import { createInstallationGateway, createPluginInstallations } from '../features/plugin-installations/index.ts';
import type { InstallationComponent, PluginInstallation } from '../features/plugin-installations/index.ts';
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
import { registerPluginDependenciesService } from './plugin-dependencies-service.ts';
import { createHttpMirroringStreaming } from '../features/mirroring-streaming/index.ts';
import type { MirroringStreamSink } from '../features/mirroring-streaming/index.ts';
import { registerMirroringStreamingService } from './mirroring-streaming-service.ts';
import {
  createBrowserConfigurationPersistence,
  createBrowserConfigurations,
  createPluginConfigurations,
  createServerConfigurations,
} from '../features/plugin-configurations/index.ts';

export interface RuntimeOptions extends ClientOptions {
  readonly timeouts?: ManagerOptions['timeouts'];
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
  // 晚注册槽位是可选的：只承认同时实现 define 的适配器，其余保持原有 append 通路。
  const slotHost: SlotHost | undefined =
    options.slotAdapter && typeof (options.slotAdapter as Partial<SlotHost>).define === 'function'
      ? (options.slotAdapter as SlotAdapter & SlotHost)
      : undefined;
  const rawClient = createApiClient(options);
  const client = createReleaseRequestClient(rawClient, {
    installations: async () => pluginInstallations.snapshot().result?.data ?? [],
    plugins: () => serverPlugins.snapshot().result?.data ?? [],
  });
  const mcp = createMcpClient(createMcpTransport(options));
  const aiSdk = createHttpAiSdk(client);
  const aiSdkStreaming = createHttpAiSdkStreaming(client);
  const performance = createHttpPerformance(client);
  const mirroringStreaming = createHttpMirroringStreaming(
    client,
    options.mirroringSink ? { sink: options.mirroringSink } : {},
  );
  const operations = createOperations(client);
  const extensions = createExtensionRegistry(
    options.themeTarget ? createDomThemeAdapter(options.themeTarget) : undefined,
  );
  const tasks = createTasks(client, extensions.beforeTaskSubmit);
  const devices = createDevices(createDeviceGateway(client, lifetime.signal));
  const artifacts = {
    upload: (filename: string, content: Blob, signal: AbortSignal) =>
      client.call(
        uploadEndpoint,
        { filename, content },
        AbortSignal.any([signal, lifetime.signal]),
      ),
    download: (id: string, signal: AbortSignal) =>
      client.downloadArtifact(id, AbortSignal.any([signal, lifetime.signal])),
  };
  const host = createHostContext(operations, tasks, lifetime, devices, artifacts, tasks);
  host.context.onDispose(registerAiSdkService(extensions, host.context, aiSdk));
  host.context.onDispose(registerAiSdkStreamingService(extensions, host.context, aiSdkStreaming));
  host.context.onDispose(registerPerformanceService(extensions, host.context, performance));
  host.context.onDispose(registerPluginDependenciesService(extensions, host.context, client));
  host.context.onDispose(
    registerMirroringStreamingService(extensions, host.context, mirroringStreaming),
  );
  const themes = extensions.themeAccess(host.context);
  const context: HostContext = Object.freeze<HostContext>({
    ...host.context,
    extensions: extensions.hostAccess(host.context),
    themes,
    services: extensions.serviceAccess(host.context, createServerServiceAccess(client, lifetime.signal)),
  });
  const serverPlugins = createServerPlugins(
    client,
    createCatalogRefresh(operations.refresh, devices, operations.invalidate),
  );
  let legacyStorage: Storage | undefined;
  try {
    legacyStorage = typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    legacyStorage = undefined;
  }
  const browserConfigurations = createBrowserConfigurations({
    baseUrl: options.baseUrl,
    persistence: createBrowserConfigurationPersistence(client),
    legacyStorage,
    signal: lifetime.signal,
  });
  const releaseSources = new Map<string, { id: string; revision: string; url: string }>();
  const webPlugins = createPluginManager({
    host: context,
    hostForPlugin(id) {
      const release = releaseSources.get(id);
      if (!release) return context;
      return createReleaseHost(context, rawClient, release, tasks, devices);
    },
    panelTarget: options.panelTarget,
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    extensionRegistry: extensions,
    configuration: (plugin, signal) =>
      browserConfigurations.prepare(plugin.id, plugin.configuration ?? null, signal),
    configurationApplied: (plugin, signal) => browserConfigurations.markApplied(plugin.id, signal),
    ...(options.componentTarget ? { componentTarget: options.componentTarget } : {}),
    ...(options.moduleTarget ? { moduleTarget: options.moduleTarget } : {}),
    ...(options.slotAdapter ? { slotAdapter: options.slotAdapter } : {}),
  });
  const resolveEntry: PackageEntryResolver = (descriptor, runId) => {
    const release = releaseSources.get(descriptor.id);
    if (release) return release.url;
    return options.packageEntryResolver?.(descriptor, runId) ??
      browserPackageEntryUrl(options.baseUrl, {
        id: descriptor.id,
        run_id: runId,
        path: descriptor.entryPath,
      });
  };
  const browserPackages = createInstalledPackageController(
    webPlugins,
    resolveEntry,
    options.esmImporter,
  );
  const pluginPackages = createPluginPackages(client, {
    enableServer: serverPlugins.load,
    disableServer: serverPlugins.unload,
    async prepareServerRemoval(id, signal) {
      const running = await serverPlugins.refresh(signal);
      if (running.data.some((plugin) => plugin.id === id)) await serverPlugins.unload(id, signal);
    },
    async enableBrowser(pkg, signal) {
      const dependencies = await createPluginDependenciesHttp(client).get({ kind: 'browser', id: pkg.id }, signal);
      signal.throwIfAborted();
      if (!dependencies.data.ready)
        throw new ApiError('protocol', 'dependencies_required', '浏览器插件必需依赖未就绪，请在依赖面板补装或重新检测', null, dependencies.logId);
      return browserPackages.enable(
        { id: pkg.id, version: pkg.version, entryPath: pkg.entry_path },
        signal,
      );
    },
    disableBrowser: browserPackages.disable,
    forgetBrowser: browserPackages.forget,
  });
  async function prepareReleaseBrowser(installation: PluginInstallation, component: InstallationComponent, signal: AbortSignal) {
      if (component.revision !== installation.revision) throw new Error('浏览器组件修订与功能安装修订不一致');
      if (!component.entryUrl) throw new Error('浏览器组件缺少不可变入口地址');
      const url = new URL(component.entryUrl, options.baseUrl);
      const prefix = `/api/v2/plugin-installations/browser/${encodeURIComponent(component.id)}/revisions/${installation.revision}/assets/`;
      if (url.origin !== new URL(options.baseUrl).origin || !url.pathname.startsWith(prefix) || url.search || url.hash)
        throw new Error('浏览器组件入口超出当前安装修订的资源边界');
      const previous = releaseSources.get(component.id);
      if (previous && previous.revision !== installation.revision) await browserPackages.forget(component.id);
      signal.throwIfAborted();
      releaseSources.set(component.id, { id: installation.id, revision: installation.revision, url: url.href });
      browserPackages.register({ id: component.id, version: component.version, entryPath: component.entryPath });
  }
  const pluginInstallations = createPluginInstallations(createInstallationGateway(client), {
    async enable(installation, component, signal) {
      await prepareReleaseBrowser(installation, component, signal);
      await browserPackages.enable({ id: component.id, version: component.version, entryPath: component.entryPath }, signal);
    },
    async disable(component, signal) {
      await browserPackages.forget(component.id);
      signal.throwIfAborted();
      releaseSources.delete(component.id);
    },
  });
  const pluginConfigurations = createPluginConfigurations({
    server: createServerConfigurations(client),
    browser: browserConfigurations,
    async inspectBrowser(id, signal) {
      const cached = pluginInstallations.snapshot().result?.data;
      const known = cached?.find((installation) => installation.components.some((item) => item.kind === 'browser' && item.id === id));
      if (known) {
        const component = known.components.find((item) => item.kind === 'browser' && item.id === id);
        if (!component) throw new Error('浏览器组件不在当前安装目录中');
        await prepareReleaseBrowser(known, component, signal);
        return webPlugins.inspectConfiguration(id, signal);
      }
      const snapshot = pluginPackages.snapshot('browser');
      const packages = snapshot.result ?? (await pluginPackages.refresh('browser', signal));
      const pkg = packages.data.find((entry) => entry.id === id);
      if (!pkg) {
        const directory = await pluginInstallations.refresh(signal);
        for (const installation of directory.data) {
          const component = installation.components.find((item) => item.kind === 'browser' && item.id === id);
          if (!component) continue;
          await prepareReleaseBrowser(installation, component, signal);
          return webPlugins.inspectConfiguration(id, signal);
        }
        throw new Error('浏览器插件不在当前安装目录中');
      }
      browserPackages.register({ id: pkg.id, version: pkg.version, entryPath: pkg.entry_path });
      return webPlugins.inspectConfiguration(id, signal);
    },
    async reloadBrowser(id, signal) {
      const selected = themes.snapshot().selected;
      await webPlugins.unload(id);
      signal.throwIfAborted();
      let cancellation: Promise<void> | null = null;
      const cancel = () => {
        cancellation = webPlugins.unload(id);
        void cancellation.catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await webPlugins.load(id);
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener('abort', cancel);
        if (cancellation) await cancellation;
      }
      if (
        selected?.pluginId === id &&
        themes.snapshot().themes.some((theme) => theme.id === selected.id)
      )
        themes.select(selected.id);
    },
  });
  let lastOperations: unknown = null;
  host.context.onDispose(
    operations.subscribe((snapshot) => {
      if (!snapshot.result || snapshot.result.data === lastOperations || lifetime.signal.aborted)
        return;
      lastOperations = snapshot.result.data;
      context.extensions?.emitEvent(
        'host.operations.changed',
        snapshot.result.data.map((entry) => entry.id),
      );
    }),
  );
  let disposal: Promise<void> | null = null;
  return {
    host: context,
    operations,
    tasks,
    devices,
    serverPlugins,
    pluginPackages,
    pluginInstallations,
    requestClient: client,
    installationArtifacts: {
      upload: (filename: string, content: Blob, signal: AbortSignal) => client.call(uploadInstallationArtifactEndpoint,
        { filename, content }, AbortSignal.any([signal, lifetime.signal])),
    },
    pluginConfigurations,
    webPlugins,
    themes,
    extensions: {
      catalog: extensions.catalog,
      subscribe: extensions.subscribe,
      executeCommand: extensions.executeCommand,
      callService: extensions.callService,
      mountComponent: webPlugins.mountComponent,
      mountModule: webPlugins.mountModule,
      unmount: webPlugins.unmountExtension,
      ...(slotHost ? { slots: slotHost } : {}),
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
      const release = mirroringStreaming.snapshot().session
        ? mirroringStreaming.release(new AbortController().signal)
        : Promise.resolve();
      lifetime.abort();
      aiSdk.dispose();
      aiSdkStreaming.dispose();
      performance.dispose();
      operations.dispose();
      tasks.dispose();
      devices.dispose();
      serverPlugins.dispose();
      pluginPackages.dispose();
      pluginInstallations.dispose();
      disposal = (async () => {
        const results = await Promise.allSettled([
          webPlugins.dispose(),
          host.dispose(),
          mcp.dispose(),
          release.finally(() => mirroringStreaming.dispose()),
        ]);
        extensions.dispose();
        browserPackages.clearSources();
        releaseSources.clear();
        browserConfigurations.dispose();
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            '前端运行实例关闭失败',
          );
      })();
      return disposal;
    },
  };
}
