import { HostError } from '../plugin-sdk/index.ts';
import type {
  HostContext,
  SlotAdapter,
  SlotLease,
  WebPlugin,
  WebPluginRuntimeInfo,
} from '../plugin-sdk/index.ts';
import { readPluginModule, validateContributions } from './contracts.ts';
import { createPluginScope } from './scope.ts';
import type { PluginScope } from './scope.ts';
import { createExtensionRegistry } from './extensions/registry.ts';
import type { ExtensionRegistry } from './extensions/registry.ts';
import { createExtensionMounts } from './extensions/mounts.ts';

export type TrustedRegistration = { readonly id: string; readonly trusted: true } & (
  | { readonly plugin: WebPlugin }
  | { readonly loader: (signal: AbortSignal) => Promise<unknown> }
);
export type PluginSnapshot = WebPluginRuntimeInfo;
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
  readonly host: HostContext;
  readonly panelTarget: (pluginId: string, panelId: string) => HTMLElement | null;
  readonly extensionRegistry?: ExtensionRegistry;
  readonly componentTarget?: (
    slot: string,
    pluginId: string,
    componentId: string,
  ) => HTMLElement | null;
  readonly moduleTarget?: (route: string, pluginId: string, moduleId: string) => HTMLElement | null;
  readonly slotAdapter?: SlotAdapter;
}

export function createPluginManager(options: ManagerOptions) {
  const registry = options.extensionRegistry ?? createExtensionRegistry();
  const mounts = createExtensionMounts();
  const sources = new Map<string, TrustedRegistration>();
  const running = new Map<string, Runtime>();
  const epochs = new Map<string, number>();
  const panelEpochs = new Map<string, number>();
  const extensionEpochs = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();
  let generation = 0;
  let closed = false;
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const pending = queue.then(run, run);
    queue = pending.catch(() => undefined);
    return pending;
  }
  function active(runtime: Runtime) {
    if (closed || runtime.scope.context.signal.aborted || running.get(runtime.id) !== runtime) {
      throw new HostError('cancelled', 'plugin_unloaded', '插件代际已撤销');
    }
  }
  async function cleanup(runtime: Runtime) {
    runtime.scope.close();
    const failures: unknown[] = [];
    try {
      await runtime.scope.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (runtime.activationStarted) {
      try {
        await runtime.plugin?.deactivate?.();
      } catch (error) {
        failures.push(error);
      }
      runtime.activationStarted = false;
    }
    if (running.get(runtime.id) === runtime) running.delete(runtime.id);
    if (failures.length) throw new AggregateError(failures, '插件卸载未完整释放资源');
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
    const scope = createPluginScope(options.host);
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
      const plugin = readPluginModule(
        'plugin' in source ? source.plugin : await source.loader(runtime.scope.context.signal),
      );
      active(runtime);
      if (plugin.id !== id) throw new Error('加载模块与预注册插件标识不一致');
      validateContributions(
        [...running.values()].flatMap((item) => (item.plugin ? [item.plugin] : [])).concat(plugin),
      );
      runtime.plugin = plugin;
      runtime.context = registry.attach(
        id,
        runtime.generation,
        runtime.scope.context,
        runtime.scope.track,
      );
      if (plugin.contributions)
        runtime.scope.track(
          registry.register(
            { pluginId: id, generation: runtime.generation, context: runtime.context },
            plugin.contributions,
          ),
        );
      runtime.activationStarted = true;
      await plugin.activate?.(runtime.context);
      active(runtime);
      runtime.state = 'loaded';
      return { id, generation: runtime.generation, state: runtime.state };
    } catch (error) {
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
    scope.track(() => root.remove());
    runtime.scope.track(() => scope.dispose());
    runtime.panels.set(panelId, { scope, root });
    try {
      target.append(root);
      const release = await panel.mount(root, scope.context);
      if (typeof release !== 'function') throw new Error('面板挂载必须返回释放函数');
      scope.track(release);
      active(runtime);
      if (scope.context.signal.aborted)
        throw new HostError('cancelled', 'panel_unmounted', '面板已撤销');
    } catch (error) {
      if (scope.context.signal.aborted && !runtime.scope.context.signal.aborted) {
        try {
          await scope.dispose();
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
    return serial(async () => {
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
    let lease: SlotLease | null = null;
    try {
      if ('slot' in entry.contribution && options.slotAdapter) {
        lease = await options.slotAdapter.acquire(
          {
            slot: entry.contribution.slot,
            pluginId: runtime.id,
            generation: runtime.generation,
            componentId: id,
            mode: entry.contribution.mode ?? 'append',
          },
          entry.owner.context.signal,
        );
      }
      if (
        'slot' in entry.contribution &&
        entry.contribution.mode === 'replace' &&
        !options.slotAdapter
      )
        throw new Error('替换渲染必须注入公开槽位适配器');
      const target =
        lease?.target ??
        ('slot' in entry.contribution
          ? options.componentTarget?.(entry.contribution.slot, runtime.id, id)
          : options.moduleTarget?.(entry.contribution.route, runtime.id, id));
      if (!target) throw new Error('宿主未分配组件槽位或模块挂载位置');
      await mounts.mount(
        entry,
        target,
        () => (kind === 'component' ? registry.component(id) : registry.module(id)) === entry,
        lease?.dispose,
      );
      active(runtime);
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await lease?.dispose();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (
        error instanceof HostError &&
        error.kind === 'cancelled' &&
        !runtime.scope.context.signal.aborted
      ) {
        if (failures.length > 1) throw new AggregateError(failures, '扩展挂载取消后释放失败');
        throw error;
      }
      try {
        await cleanup(runtime);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) throw new AggregateError(failures, '扩展挂载失败且插件回滚不完整');
      throw error;
    }
  }
  return {
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
      return serial(() => loadNow(id, epoch));
    },
    mount: (id: string, panelId: string) => {
      const epoch = panelEpochs.get(panelId) ?? 0;
      return serial(() => mountNow(id, panelId, epoch));
    },
    unmount(id: string, panelId: string) {
      panelEpochs.set(panelId, (panelEpochs.get(panelId) ?? 0) + 1);
      running.get(id)?.panels.get(panelId)?.scope.close();
      return serial(async () => {
        const runtime = running.get(id);
        const panel = runtime?.panels.get(panelId);
        if (!runtime || !panel) return;
        try {
          await panel.scope.dispose();
        } finally {
          runtime.panels.delete(panelId);
        }
      });
    },
    unload,
    unregister(id: string) {
      epochs.set(id, (epochs.get(id) ?? 0) + 1);
      running.get(id)?.scope.close();
      return serial(async () => {
        const runtime = running.get(id);
        if (runtime) await cleanup(runtime);
        sources.delete(id);
      });
    },
    extensions: registry,
    mountComponent: (id: string) => {
      const epoch = extensionEpochs.get(id) ?? 0;
      return serial(() => mountExtension('component', id, epoch));
    },
    mountModule: (id: string) => {
      const epoch = extensionEpochs.get(id) ?? 0;
      return serial(() => mountExtension('module', id, epoch));
    },
    unmountExtension: (id: string) => {
      extensionEpochs.set(id, (extensionEpochs.get(id) ?? 0) + 1);
      mounts.close(id);
      return serial(() => mounts.unmount(id));
    },
    snapshot: (): readonly PluginSnapshot[] =>
      [...running.values()].map(({ id, generation, state }) => ({ id, generation, state })),
    dispose() {
      closed = true;
      for (const runtime of running.values()) runtime.scope.close();
      return serial(async () => {
        const failures: unknown[] = [];
        for (const runtime of [...running.values()].reverse()) {
          try {
            await cleanup(runtime);
          } catch (error) {
            failures.push(error);
          }
        }
        sources.clear();
        if (!options.extensionRegistry) registry.dispose();
        if (failures.length) throw new AggregateError(failures, '插件管理器关闭时有资源释放失败');
      });
    },
  };
}
