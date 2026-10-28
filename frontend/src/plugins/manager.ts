import { HostError, pageSlotId } from '../plugin-sdk/index.ts';
import type {
  HostContext,
  SlotAdapter,
  SlotLease,
  WebPlugin,
  WebPluginRuntimeInfo,
  ConfigurationAccess,
} from '../plugin-sdk/index.ts';
import { readPluginModule, validateContributions } from './contracts.ts';
import { createPluginScope } from './scope.ts';
import type { PluginScope } from './scope.ts';
import { createExtensionRegistry } from './extensions/registry.ts';
import type { ExtensionRegistry } from './extensions/registry.ts';
import { createExtensionMounts } from './extensions/mounts.ts';
import { awaitLifecycle, createKeyedQueue, lifecycleTimeouts } from './lifecycle.ts';
import type { LifecycleTimeouts } from './lifecycle.ts';

export type TrustedRegistration = { readonly id: string; readonly trusted: true } & (
  | { readonly plugin: WebPlugin }
  | { readonly loader: (signal: AbortSignal) => Promise<unknown> }
);
export type PluginSnapshot = WebPluginRuntimeInfo;
interface CleanupDiagnostic {
  readonly id: string;
  readonly generation: number;
  readonly error: unknown;
}

interface MountedPanel {
  readonly scope: PluginScope;
  readonly root: HTMLElement;
}
interface Runtime {
  readonly id: string;
  readonly generation: number;
  readonly scope: PluginScope;
  context: HostContext;
  readonly panels: Map<string, MountedPanel>;
  plugin: WebPlugin | null;
  activationStarted: boolean;
  state: 'loading' | 'loaded';
}
export interface ManagerOptions {
  readonly timeouts?: Partial<LifecycleTimeouts>;
  readonly host: HostContext;
  readonly hostForPlugin?: (id: string) => HostContext;
  readonly debugForPlugin?: (
    id: string,
    generation: number,
    scope: PluginScope,
  ) => HostContext['debug'];
  readonly observe?: (event: PluginLifecycleObservation) => void;
  readonly panelTarget: (pluginId: string, panelId: string) => HTMLElement | null;
  readonly extensionRegistry?: ExtensionRegistry;
  readonly componentTarget?: (
    slot: string,
    pluginId: string,
    componentId: string,
  ) => HTMLElement | null;
  readonly moduleTarget?: (route: string, pluginId: string, moduleId: string) => HTMLElement | null;
  readonly slotAdapter?: SlotAdapter;
  readonly configuration?: (
    plugin: WebPlugin,
    signal: AbortSignal,
  ) => ConfigurationAccess | undefined | Promise<ConfigurationAccess | undefined>;
  readonly configurationApplied?: (plugin: WebPlugin, signal: AbortSignal) => void | Promise<void>;
}

export interface PluginLifecycleObservation {
  readonly pluginId: string;
  readonly generation: number;
  readonly stage: 'loading' | 'loaded' | 'failed' | 'unloading' | 'unloaded' | 'cleanup_failed';
  readonly at: number;
}

export function createPluginManager(options: ManagerOptions) {
  const registry = options.extensionRegistry ?? createExtensionRegistry();
  const timeouts = lifecycleTimeouts(options.timeouts);
  const mounts = createExtensionMounts(timeouts);
  const sources = new Map<string, TrustedRegistration>();
  const running = new Map<string, Runtime>();
  const cleanupFailures = new Map<string, CleanupDiagnostic>();
  const epochs = new Map<string, number>();
  const panelEpochs = new Map<string, number>();
  const extensionEpochs = new Map<string, number>();
  const extensionControllers = new Map<string, AbortController>();
  const serial = createKeyedQueue();
  let generation = 0;
  let closed = false;
  function observe(runtime: Runtime, stage: PluginLifecycleObservation['stage']) {
    try { options.observe?.({ pluginId: runtime.id, generation: runtime.generation, stage, at: Date.now() }); }
    catch { /* 观测故障不能改变插件业务的成功或失败。 */ }
  }
  const awaitCleanup = async (callback: () => void | Promise<void>, stage: string, deadline = Date.now() + timeouts.cleanupMs) => {
    try { await awaitLifecycle(callback, undefined, deadline, stage); }
    catch (error) {
      if (error instanceof HostError && error.code === 'plugin_lifecycle_timeout')
        throw new HostError('protocol', 'plugin_cleanup_timeout', error.message);
      throw error;
    }
  };
  function active(runtime: Runtime) {
    if (closed || runtime.scope.context.signal.aborted || running.get(runtime.id) !== runtime) {
      throw new HostError('cancelled', 'plugin_unloaded', '插件代际已撤销');
    }
  }
  async function cleanup(runtime: Runtime, deadline = Date.now() + timeouts.cleanupMs) {
    observe(runtime, 'unloading');
    runtime.scope.close();
    const failures: unknown[] = [];
    const work: Promise<unknown>[] = [runtime.scope.dispose()];
    if (runtime.activationStarted) {
      runtime.activationStarted = false;
      work.push(Promise.resolve().then(() => runtime.plugin?.deactivate?.()));
    }
    const completed = (async () => {
        const results = await Promise.allSettled(work);
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    })();
    try {
      await awaitCleanup(() => completed, '插件资源回收', deadline);
    } catch (error) {
      failures.push(error);
    }
    if (running.get(runtime.id) === runtime) running.delete(runtime.id);
    if (failures.length) {
      const error = new AggregateError(failures, '插件卸载未完整释放资源');
      cleanupFailures.set(runtime.id, Object.freeze({ id: runtime.id, generation: runtime.generation, error }));
      observe(runtime, 'cleanup_failed');
      throw error;
    }
    observe(runtime, 'unloaded');
  }
  async function loadNow(id: string, epoch: number): Promise<PluginSnapshot> {
    if (closed || (epochs.get(id) ?? 0) !== epoch)
      throw new HostError('cancelled', 'plugin_unloaded', '加载请求已撤销');
    const existing = running.get(id);
    if (existing) {
      active(existing);
      return { id, generation: existing.generation, state: existing.state };
    }
    const source = sources.get(id);
    if (!source) throw new Error('插件未经过可信预注册');
    const scope = createPluginScope(options.hostForPlugin?.(id) ?? options.host);
    const runtime: Runtime = {
      id,
      generation: ++generation,
      scope,
      context: scope.context,
      panels: new Map(),
      plugin: null,
      activationStarted: false,
      state: 'loading',
    };
    running.set(id, runtime);
    try {
      const debug = options.debugForPlugin?.(id, runtime.generation, scope);
      if (debug) runtime.context = { ...runtime.context, debug };
    } catch { /* 调试底座不可用时仍正常加载业务插件。 */ }
    observe(runtime, 'loading');
    const deadline = Date.now() + timeouts.loadMs;
    try {
      const plugin = readPluginModule(
        'plugin' in source ? source.plugin : await awaitLifecycle(
          () => source.loader(scope.context.signal), scope.context.signal, deadline, '插件加载'),
      );
      active(runtime);
      if (plugin.id !== id) throw new Error('加载模块与预注册插件标识不一致');
      validateContributions(
        [...running.values()].flatMap((item) => (item.plugin ? [item.plugin] : [])).concat(plugin),
      );
      runtime.plugin = plugin;
      const prepareConfiguration = options.configuration;
      const configuration = prepareConfiguration
        ? await awaitLifecycle(
            () => Promise.resolve(prepareConfiguration(plugin, runtime.scope.context.signal)),
            runtime.scope.context.signal,
            deadline, '插件配置准备',
          )
        : undefined;
      active(runtime);
      if (configuration)
        runtime.context = {
          ...runtime.context,
          configuration: {
            get() {
              active(runtime);
              return configuration.get();
            },
            subscribe(listener) {
              active(runtime);
              return runtime.scope.track(
                configuration.subscribe((value) => {
                  if (!runtime.scope.context.signal.aborted) listener(value);
                }),
              );
            },
          },
        };
      runtime.context = registry.attach(
        id,
        runtime.generation,
        runtime.context,
        runtime.scope.track,
        true,
        plugin.version,
      );
      if (plugin.contributions)
        runtime.scope.track(
          registry.register(
            { pluginId: id, generation: runtime.generation, version: plugin.version, context: runtime.context },
            plugin.contributions,
          ),
        );
      runtime.activationStarted = true;
      await awaitLifecycle(() => plugin.activate?.(runtime.context), scope.context.signal, deadline, '插件激活');
      active(runtime);
      const applyConfiguration = options.configurationApplied;
      if (applyConfiguration)
        await awaitLifecycle(async () => {
          await applyConfiguration(plugin, runtime.scope.context.signal);
        }, runtime.scope.context.signal, deadline, '插件配置应用');
      active(runtime);
      runtime.state = 'loaded';
      registry.publishServices(id, runtime.generation);
      observe(runtime, 'loaded');
      return { id, generation: runtime.generation, state: runtime.state };
    } catch (error) {
      observe(runtime, 'failed');
      try {
        await cleanup(runtime);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '插件加载失败且回滚不完整');
      }
      throw error;
    }
  }
  async function mountNow(id: string, panelId: string, epoch: number) {
    if ((panelEpochs.get(panelId) ?? 0) !== epoch)
      throw new HostError('cancelled', 'panel_unmounted', '排队面板挂载已撤销');
    const runtime = running.get(id);
    if (!runtime?.plugin || runtime.state !== 'loaded') throw new Error('插件尚未激活');
    active(runtime);
    if (runtime.panels.has(panelId)) return;
    const panel = runtime.plugin.panels.find((item) => item.id === panelId);
    if (!panel) throw new Error('插件没有贡献此面板');
    const target = options.panelTarget(id, panelId);
    if (!target) throw new Error('宿主未分配面板挂载位置');
    const scope = createPluginScope(runtime.context);
    const root = target.ownerDocument.createElement('div');
    root.dataset.deviceforgePanel = panelId;
    root.dataset.deviceforgePlugin = runtime.id;
    root.dataset.deviceforgeGeneration = String(runtime.generation);
    scope.track(() => root.remove());
    runtime.scope.track(() => scope.dispose());
    runtime.panels.set(panelId, { scope, root });
    try {
      target.append(root);
      const release = await awaitLifecycle(() => panel.mount(root, scope.context), scope.context.signal,
        Date.now() + timeouts.mountMs, '面板挂载', (late) => { if (typeof late === 'function') scope.track(late); });
      if (typeof release !== 'function') throw new Error('面板挂载必须返回释放函数');
      scope.track(release);
      active(runtime);
      if (scope.context.signal.aborted)
        throw new HostError('cancelled', 'panel_unmounted', '面板已撤销');
    } catch (error) {
      if (scope.context.signal.aborted && !runtime.scope.context.signal.aborted) {
        try {
          await awaitCleanup(() => scope.dispose(), '撤销面板资源回收');
        } finally {
          runtime.panels.delete(panelId);
        }
        throw error;
      }
      // 挂载失败回滚整代，防止激活逻辑与其余面板留下部分状态。
      try {
        await cleanup(runtime);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '面板挂载失败且回滚不完整');
      }
      throw error;
    }
  }
  function unload(id: string) {
    epochs.set(id, (epochs.get(id) ?? 0) + 1);
    running.get(id)?.scope.close();
    return serial(id, async () => {
      const runtime = running.get(id);
      if (runtime) await cleanup(runtime);
    });
  }
  async function mountExtension(kind: 'component' | 'module', id: string, epoch: number) {
    if ((extensionEpochs.get(id) ?? 0) !== epoch)
      throw new HostError('cancelled', 'mount_revoked', '排队扩展挂载已撤销');
    const entry = kind === 'component' ? registry.component(id) : registry.module(id);
    if (!entry) throw new Error('扩展挂载入口不存在或已撤销');
    const runtime = running.get(entry.owner.pluginId);
    if (!runtime || runtime.generation !== entry.owner.generation)
      throw new Error('扩展运行代次无效');
    active(runtime);
    if (mounts.has(entry)) return;
    // 模块没有自己的槽位字段：它的页面槽位由 pluginId + route 派生，
    // 这样插件页和路由级接管走的是同一条挂载通路（同一套代次、租约与回滚）。
    const isModuleContribution = !('slot' in entry.contribution);
    const slot = isModuleContribution
      ? pageSlotId(runtime.id, entry.contribution.route)
      : entry.contribution.slot;
    const mode = isModuleContribution ? 'replace' : (entry.contribution.mode ?? 'append');
    const controller = new AbortController();
    extensionControllers.set(id, controller);
    const signal = AbortSignal.any([entry.owner.context.signal, controller.signal]);
    const deadline = Date.now() + timeouts.mountMs;
    const cleanupBudget: { deadline?: number } = {};
    let lease: SlotLease | null = null;
    try {
      if (options.slotAdapter) {
        const adapter = options.slotAdapter;
        lease = await awaitLifecycle(() => adapter.acquire(
          {
            slot,
            pluginId: runtime.id,
            generation: runtime.generation,
            componentId: id,
            mode,
          },
          signal,
        ), signal, deadline, '槽位申请', (late) => late.dispose());
        const acquired = lease;
        let disposal: Promise<void> | null = null;
        lease = { target: acquired.target, dispose: () => (disposal ??= Promise.resolve().then(() => acquired.dispose())) };
      }
      // 组件声明 replace 时必须真的能替换；模块的页面槽位允许退回 moduleTarget，保持旧装配可用。
      if (!isModuleContribution && mode === 'replace' && !options.slotAdapter)
        throw new Error('替换渲染必须注入公开槽位适配器');
      const target =
        lease?.target ??
        (isModuleContribution
          ? options.moduleTarget?.(entry.contribution.route, runtime.id, id)
          : options.componentTarget?.(entry.contribution.slot, runtime.id, id));
      if (!target) throw new Error('宿主未分配组件槽位或模块挂载位置');
      await mounts.mount(
        entry,
        target,
        () => (kind === 'component' ? registry.component(id) : registry.module(id)) === entry,
        lease?.dispose,
        signal,
        deadline,
        cleanupBudget,
      );
      active(runtime);
    } catch (error) {
      cleanupBudget.deadline ??= Date.now() + timeouts.cleanupMs;
      const failures: unknown[] = [error];
      try {
        await awaitCleanup(() => lease?.dispose(), '扩展槽位回收', cleanupBudget.deadline);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (signal.aborted && !runtime.scope.context.signal.aborted) {
        if (failures.length > 1) throw new AggregateError(failures, '扩展挂载取消后释放失败');
        throw error;
      }
      try {
        await cleanup(runtime, cleanupBudget.deadline);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) throw new AggregateError(failures, '扩展挂载失败且插件回滚不完整');
      throw error;
    } finally {
      if (extensionControllers.get(id) === controller) extensionControllers.delete(id);
    }
  }
  return {
    async inspectConfiguration(id: string, signal: AbortSignal) {
      signal.throwIfAborted();
      const source = sources.get(id);
      if (!source) throw new Error('插件来源尚未登记');
      const plugin = readPluginModule(
        'plugin' in source ? source.plugin : await awaitLifecycle(() => source.loader(signal), signal,
          Date.now() + timeouts.loadMs, '插件配置检查'),
      );
      signal.throwIfAborted();
      if (plugin.id !== id) throw new Error('插件标识与登记来源不一致');
      return plugin.configuration ?? null;
    },
    register(source: TrustedRegistration) {
      if (closed) throw new Error('插件管理器已关闭');
      if (source.trusted !== true || !/^[a-z][a-z0-9._-]{0,99}$/.test(source.id))
        throw new Error('仅接受有效的可信插件登记');
      if (sources.has(source.id)) throw new Error('可信插件已登记');
      if ('plugin' in source) {
        const plugin = readPluginModule(source.plugin);
        if (plugin.id !== source.id) throw new Error('预注册标识不一致');
      } else if (typeof source.loader !== 'function') throw new Error('必须提供可信模块加载器');
      sources.set(source.id, source);
    },
    load: (id: string) => {
      const epoch = epochs.get(id) ?? 0;
      return serial(id, () => loadNow(id, epoch));
    },
    mount: (id: string, panelId: string) => {
      const epoch = panelEpochs.get(panelId) ?? 0;
      return serial(id, () => mountNow(id, panelId, epoch));
    },
    unmount(id: string, panelId: string) {
      panelEpochs.set(panelId, (panelEpochs.get(panelId) ?? 0) + 1);
      running.get(id)?.panels.get(panelId)?.scope.close();
      return serial(id, async () => {
        const runtime = running.get(id);
        const panel = runtime?.panels.get(panelId);
        if (!runtime || !panel) return;
        try {
          await awaitCleanup(() => panel.scope.dispose(), '面板资源回收');
        } catch (error) {
          cleanupFailures.set(id, Object.freeze({ id, generation: runtime.generation, error }));
          throw error;
        } finally {
          runtime.panels.delete(panelId);
        }
      });
    },
    unload,
    unregister(id: string) {
      epochs.set(id, (epochs.get(id) ?? 0) + 1);
      running.get(id)?.scope.close();
      return serial(id, async () => {
        const runtime = running.get(id);
        if (runtime) await cleanup(runtime);
        sources.delete(id);
      });
    },
    extensions: registry,
    mountComponent: (id: string) => {
      const epoch = extensionEpochs.get(id) ?? 0;
      return serial(registry.component(id)?.owner.pluginId ?? id, () => mountExtension('component', id, epoch));
    },
    mountModule: (id: string) => {
      const epoch = extensionEpochs.get(id) ?? 0;
      return serial(registry.module(id)?.owner.pluginId ?? id, () => mountExtension('module', id, epoch));
    },
    unmountExtension: (id: string) => {
      extensionEpochs.set(id, (extensionEpochs.get(id) ?? 0) + 1);
      extensionControllers.get(id)?.abort();
      mounts.close(id);
      const owner = registry.component(id)?.owner.pluginId ?? registry.module(id)?.owner.pluginId ?? id;
      return serial(owner, () => awaitCleanup(() => mounts.unmount(id), '扩展资源回收'));
    },
    snapshot: (): readonly PluginSnapshot[] =>
      [...running.values()].map(({ id, generation, state }) => ({ id, generation, state })),
    diagnosticSnapshot: () => [...running.values()].map((runtime) => ({
      id: runtime.id, generation: runtime.generation, state: runtime.state,
      version: runtime.plugin?.version ?? null,
      panels: (runtime.plugin?.panels ?? []).map((panel) => ({
        id: panel.id, title: panel.title, mounted: runtime.panels.has(panel.id),
      })),
    })),
    // 每个插件仅保留最近一条清理诊断；成功新代不会抹掉旧故障，也不受其封锁。
    cleanupSnapshot: (): readonly CleanupDiagnostic[] => [...cleanupFailures.values()],
    dispose() {
      closed = true;
      for (const runtime of running.values()) runtime.scope.close();
      return (async () => {
        const failures: unknown[] = [];
        for (const runtime of [...running.values()].reverse()) {
          try {
            await serial(runtime.id, () => cleanup(runtime));
          } catch (error) {
            failures.push(error);
          }
        }
        sources.clear();
        if (!options.extensionRegistry) registry.dispose();
        if (failures.length) throw new AggregateError(failures, '插件管理器关闭时有资源释放失败');
      })();
    },
  };
}
