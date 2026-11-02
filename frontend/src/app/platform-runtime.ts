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
import type { ManagerOptions, SlotDirectory } from '../plugins/index.ts';
import type {
  EsmImporter,
  HostContext,
  PackageEntryResolver,
  SlotAdapter,
  SlotHost,
} from '../plugin-sdk/index.ts';
import { createHostContext } from './host-context.ts';
import { createPluginTransport } from './plugin-transport.ts';
import { createPluginCleanup } from './plugin-cleanup.ts';
import { scopedTransportAccess } from '../plugins/transport-access.ts';
import { registerWorkspaceStorageService } from './workspace-storage-service.ts';
import { createRecoveryState } from './composition/recovery-state.ts';
import { registerRecoveryService } from './composition/recovery-service.ts';
import { registerPlatformServices } from './composition/platform-services.ts';
import type { PlatformConnection } from './composition/platform-services.ts';
import { registerUiDirectory } from './composition/ui-directory.ts';
import { createWorkspaceStorage } from './workspace-storage.ts';
import type { WorkspaceStorageLike } from './workspace-storage.ts';
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
import { createMcpClient } from '../features/mcp/index.ts';
import { legacyBusinessAliases, registerLegacyServiceAliases } from './composition/legacy-service-aliases.ts';
import { registerPluginDependenciesService } from './plugin-dependencies-service.ts';
import { createRuntimeDebugger } from './debugger-runtime.ts';
import { createDebuggerBuildDirectory } from './debugger-builds.ts';
import type { DebuggerRunningBuild } from './debugger-builds.ts';
import { createDebuggerReload } from './debugger-reload.ts';
import type { RuntimeDebuggerOptions } from './debugger-runtime.ts';
import { isLoopbackDebuggerAddress } from '../features/debugger/index.ts';
import { createDeveloperToolsHost } from './developer-tools.ts';
import { createHttpMirroringStreaming } from '../features/mirroring-streaming/index.ts';
import type { MirroringStreamSink } from '../features/mirroring-streaming/index.ts';
import { registerMirroringStreamingService } from './mirroring-streaming-service.ts';
import {
  createBrowserConfigurationPersistence,
  createBrowserConfigurations,
  createPluginConfigurations,
  createServerConfigurations,
} from '../features/plugin-configurations/index.ts';

export interface PlatformRuntimeOptions extends ClientOptions {
  readonly debugger?: RuntimeDebuggerOptions;
  readonly developerTools?: boolean;
  readonly timeouts?: ManagerOptions['timeouts'];
  readonly panelTarget: ManagerOptions['panelTarget'];
  readonly componentTarget?: ManagerOptions['componentTarget'];
  readonly moduleTarget?: ManagerOptions['moduleTarget'];
  readonly esmImporter?: EsmImporter;
  readonly packageEntryResolver?: PackageEntryResolver;
  readonly slotAdapter?: ManagerOptions['slotAdapter'];
  readonly themeTarget?: HTMLElement;
  readonly mirroringSink?: MirroringStreamSink;
  readonly workspaceStorage?: WorkspaceStorageLike | null;
  readonly decorateWorkspaceMount?: ManagerOptions['decorateWorkspaceMount'];
  readonly connection?: PlatformConnection;
  readonly slotDirectory?: SlotDirectory;
  /** 只登记旧服务名称的薄转调，不导入或创建旧业务模型。 */
  readonly legacyServiceAliases?: boolean;
}
export function createPlatformRuntime(options: PlatformRuntimeOptions) {
  const lifetime = new AbortController();
  const recovery = createRecoveryState();
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
  host.context.onDispose(registerPluginDependenciesService(extensions, host.context, client));
  host.context.onDispose(
    registerMirroringStreamingService(extensions, host.context, mirroringStreaming),
  );
  const themes = extensions.themeAccess(host.context);
  const transport = createPluginTransport(client);
  const context: HostContext = Object.freeze<HostContext>({
    ...host.context,
    transport: scopedTransportAccess(transport, lifetime.signal, host.context.onDispose),
    onCleanup: createPluginCleanup({
      signal: lifetime.signal, onDispose: host.context.onDispose, transport,
      ...(options.timeouts?.cleanupMs === undefined ? {} : { timeoutMs: options.timeouts.cleanupMs }),
    }),
    ui: extensions.uiAccess(host.context),
    data: extensions.dataAccess(host.context),
    extensions: extensions.hostAccess(host.context),
    themes,
    services: extensions.serviceAccess(host.context, createServerServiceAccess(client, lifetime.signal)),
  });
  if (options.legacyServiceAliases !== false)
    registerLegacyServiceAliases(context, extensions, legacyBusinessAliases);
  const shellPoint = context.extensions?.points;
  if (shellPoint) host.context.onDispose(shellPoint.define({
    id: 'host.shell', version: '1', title: '工作区外壳', modes: ['replace'],
    inputSchema: {
      type: 'object', required: ['pluginId', 'viewId'], additionalProperties: false,
      properties: { pluginId: { type: 'string', minLength: 1 }, viewId: { type: 'string', minLength: 1 } },
    },
  }));
  host.context.onDispose(registerRecoveryService(extensions, context, recovery));
  registerPlatformServices({ host: context, extensions }, {
    connection: options.connection ?? { baseUrl: options.baseUrl }, mcp,
  });
  registerUiDirectory({ host: context, extensions,
    ...(options.slotDirectory ? { slots: options.slotDirectory } : {}),
  });
  host.context.onDispose(recovery.dispose);
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
  const layoutStorage = options.workspaceStorage === undefined ? legacyStorage : options.workspaceStorage;
  const workspaceStorage = layoutStorage
    ? createWorkspaceStorage({
        registry: extensions.workspaces,
        storage: layoutStorage,
        key: `deviceforge:workspaces:v1:${new URL(options.baseUrl).origin}`,
        signal: lifetime.signal,
      })
    : null;
  host.context.onDispose(registerWorkspaceStorageService(extensions, context, workspaceStorage));
  const browserConfigurations = createBrowserConfigurations({
    baseUrl: options.baseUrl,
    persistence: createBrowserConfigurationPersistence(client),
    legacyStorage,
    signal: lifetime.signal,
  });
  const releaseSources = new Map<string, { id: string; revision: string; url: string }>();
  const debuggerBuilds = new Map<string, DebuggerRunningBuild>();
  const debuggerRuntime: ReturnType<typeof createRuntimeDebugger> | null = options.debugger && isLoopbackDebuggerAddress(options.baseUrl)
    ? createRuntimeDebugger({ ...options.debugger, client, context, extensions, manager: () => webPlugins,
        installation: createDebuggerBuildDirectory(client, () => [...debuggerBuilds.values()]),
        reloadPlugin: createDebuggerReload({ client, manager: () => webPlugins,
          packages: () => pluginPackages, browser: () => browserPackages, installations: () => pluginInstallations,
          forgetReleaseSource: id => { releaseSources.delete(id); } }) })
    : null;
  if (debuggerRuntime) host.context.onDispose(() => debuggerRuntime.dispose());
  let developerTools: ReturnType<typeof createDeveloperToolsHost> | null = null;
  const webPlugins = createPluginManager({
    host: context,
    hostForPlugin(id) {
      const release = releaseSources.get(id);
      if (!release) return context;
      return createReleaseHost(context, rawClient, release, tasks, devices, options.timeouts?.cleanupMs);
    },
    panelTarget: options.panelTarget,
    ...(options.decorateWorkspaceMount ? { decorateWorkspaceMount: options.decorateWorkspaceMount } : {}),
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    extensionRegistry: extensions,
    ...(debuggerRuntime ? {
      debugForPlugin: (id: string, generation: number, scope: Parameters<NonNullable<ManagerOptions['debugForPlugin']>>[2]) =>
        debuggerRuntime.attach(id, String(generation), scope),
    } : {}),
    observe(event) {
      if (event.stage === 'loaded') {
        const plugin = webPlugins.diagnosticSnapshot().find(item => item.id === event.pluginId);
        const source = releaseSources.get(event.pluginId);
        if (plugin) debuggerBuilds.set(event.pluginId, { pluginId: event.pluginId,
          generation: String(event.generation), version: plugin.version ?? '',
          installationId: source?.id ?? null, revision: source?.revision ?? null });
      } else if (event.stage === 'unloaded' && debuggerBuilds.get(event.pluginId)?.generation === String(event.generation)) {
        debuggerBuilds.delete(event.pluginId);
      }
      debuggerRuntime?.observe(event);
      context.extensions?.emitEvent('host.plugins.changed', {
        pluginId: event.pluginId, generation: event.generation, stage: event.stage,
      });
      if (event.stage === 'loaded' || event.stage === 'unloaded') developerTools?.sync();
    },
    configuration: (plugin, signal) =>
      browserConfigurations.prepare(plugin.id, plugin.configuration ?? null, signal),
    configurationApplied: (plugin, signal) => browserConfigurations.markApplied(plugin.id, signal),
    ...(options.componentTarget ? { componentTarget: options.componentTarget } : {}),
    ...(options.moduleTarget ? { moduleTarget: options.moduleTarget } : {}),
    ...(options.slotAdapter ? { slotAdapter: options.slotAdapter } : {}),
  });
  if (options.developerTools) {
    developerTools = createDeveloperToolsHost(extensions, webPlugins);
    host.context.onDispose(() => developerTools?.dispose());
  }
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
      await browserPackages.prepare({ id: component.id, version: component.version, entryPath: component.entryPath });
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
      await browserPackages.prepare({ id: pkg.id, version: pkg.version, entryPath: pkg.entry_path });
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
    debugger: debuggerRuntime,
    developerTools,
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
    workspaceStorage,
    recovery,
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
    bundledPlugins: browserPackages.bundled,
    artifacts,
    mirroringStreaming,
    mcp,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      const release = mirroringStreaming.snapshot().session
        ? mirroringStreaming.release(new AbortController().signal)
        : Promise.resolve();
      lifetime.abort();
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
        const failures: unknown[] = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []);
        try { await extensions.dispose(); }
        catch (error) { failures.push(error); }
        browserPackages.clearSources();
        releaseSources.clear();
        debuggerBuilds.clear();
        browserConfigurations.dispose();
        if (failures.length)
          throw new AggregateError(
            failures,
            '前端运行实例关闭失败',
          );
      })();
      return disposal;
    },
  };
}

export type PlatformRuntime = ReturnType<typeof createPlatformRuntime>;
