import type { Dispose } from '../../plugin-sdk/index.ts';
import type { PlatformRuntime } from '../platform-runtime.ts';
import type { OfficialPluginSource } from './manifest-sources.ts';
import { createInstallationCatalog } from './installation-catalog.ts';

export interface OfficialPluginState {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly phase: 'idle' | 'loading' | 'loaded' | 'disabled' | 'external' | 'failed';
  readonly error: string | null;
}
export interface OfficialPluginsOptions {
  readonly runtime: PlatformRuntime;
  readonly sources: readonly OfficialPluginSource[];
  readonly baseUrl: string;
  readonly persistence?: Pick<Storage, 'getItem' | 'setItem'>;
}

/** 只把清单来源交给现有管理器；独立安装优先，不建立另一套装卸队列。 */
export function createOfficialPlugins(options: OfficialPluginsOptions) {
  const { runtime } = options;
  const sources = new Map(options.sources.map((source) => [source.id, source]));
  const listeners = new Set<() => void>();
  const intents = new Map<string, number>();
  const operations = new Map<string, AbortController>();
  const catalog = createInstallationCatalog(runtime);
  const states = new Map<string, OfficialPluginState>(options.sources.map((source) => [
    source.id, Object.freeze({ id: source.id, title: source.title, version: source.version, phase: 'idle', error: null }),
  ]));
  const prefix = `deviceforge.official:${new URL(options.baseUrl).origin}:`;
  let snapshot: readonly OfficialPluginState[] = Object.freeze([...states.values()]);
  let started: Promise<readonly OfficialPluginState[]> | null = null;
  let closed = false;
  function publish(id: string, phase: OfficialPluginState['phase'], error: string | null = null) {
    if (closed) return;
    const previous = states.get(id);
    if (!previous || previous.phase === phase && previous.error === error) return;
    states.set(id, Object.freeze({ ...previous, phase, error }));
    snapshot = Object.freeze([...states.values()]);
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个管理界面不阻断其他插件启停。 */ }
    }
  }
  function disabled(id: string) {
    try { return options.persistence?.getItem(`${prefix}${id}`) === 'disabled'; }
    catch { return false; }
  }
  function remember(id: string, enabled: boolean) {
    try { options.persistence?.setItem(`${prefix}${id}`, enabled ? 'enabled' : 'disabled'); }
    catch { /* 浏览器拒绝持久化时当前会话仍可明确启停，不伪造服务器错误。 */ }
  }
  function active(signal: AbortSignal) {
    signal.throwIfAborted();
    runtime.host.signal.throwIfAborted();
    if (closed) throw new Error('随附插件装配已关闭');
  }
  async function setEnabled(id: string, enabled: boolean, signal: AbortSignal) {
    active(signal);
    const source = sources.get(id);
    if (!source) throw new Error('当前随附目录没有此插件');
    const intent = (intents.get(id) ?? 0) + 1;
    const previous = operations.get(id);
    const operation = new AbortController();
    intents.set(id, intent);
    operations.set(id, operation);
    previous?.abort();
    const combined = AbortSignal.any([signal, operation.signal]);
    const latest = () => !closed && intents.get(id) === intent;
    const check = () => {
      if (!latest()) throw new Error('插件启停意图已更新，旧调用不再修改当前状态');
      active(combined);
    };
    let external = false;
    const confirm = () => {
      const state = catalog.status(id);
      if (state === 'external' || runtime.webPlugins.snapshot().some((entry) =>
        entry.id === id && !runtime.bundledPlugins.has(id))) {
        external = true;
        publish(id, 'external');
        throw new Error('该插件已有独立安装，请使用已安装插件入口管理');
      }
      if (state !== 'absent') throw new Error('安装目录已变化且尚未确认，不能启停随附插件');
    };
    // 停用偏好是随附来源的本地意图；目录未知时仍不得卸载可能属于独立安装的实例。
    if (!enabled && catalog.status(id) !== 'external') remember(id, false);
    const cancel = () => {
      if (latest() && runtime.bundledPlugins.has(id) && catalog.status(id) !== 'external')
        void runtime.webPlugins.unload(id).catch(() => undefined);
    };
    try {
      await catalog.inspect(id, combined);
      check();
      confirm();
      if (!enabled) {
        await runtime.webPlugins.unload(id);
        check();
        await catalog.inspect(id, combined);
        check();
        confirm();
        publish(id, 'disabled');
        return;
      }
      if (!runtime.bundledPlugins.has(id))
        runtime.bundledPlugins.register({ id, trusted: true, loader: source.loader });
      publish(id, 'loading');
      combined.addEventListener('abort', cancel, { once: true });
      await runtime.webPlugins.load(id);
      check();
      // 激活期间目录可能被默认启用或管理页刷新；复用原读取，不把暂时未知当成加载失败。
      await catalog.inspect(id, combined);
      check();
      confirm();
      remember(id, true);
      publish(id, 'loaded');
    } catch (error) {
      if (latest() && !external)
        publish(id, 'failed', error instanceof Error ? error.message : '插件启停结果未确认');
      throw error;
    } finally {
      combined.removeEventListener('abort', cancel);
      if (operations.get(id) === operation) operations.delete(id);
    }
  }
  const unsubscribe = runtime.host.extensions?.subscribeEvent('host.plugins.changed', ({ data }) => {
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !('pluginId' in data) || typeof data.pluginId !== 'string' || !sources.has(data.pluginId) ||
        !('stage' in data) || typeof data.stage !== 'string') return;
    if (data.stage === 'loaded') publish(data.pluginId,
      catalog.status(data.pluginId) === 'external' || !runtime.bundledPlugins.has(data.pluginId) ? 'external' : 'loaded');
    if (data.stage === 'unloaded' && runtime.bundledPlugins.has(data.pluginId)) publish(data.pluginId, 'disabled');
  });
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void): Dispose { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start(signal: AbortSignal): Promise<readonly OfficialPluginState[]> {
      started ??= (async () => {
        active(signal);
        await Promise.all([...sources.values()].map(async (source) => {
          if (intents.has(source.id)) return;
          try {
            if (disabled(source.id)) {
              const external = await catalog.inspect(source.id, signal);
              active(signal);
              if (!intents.has(source.id)) publish(source.id, external ? 'external' : 'disabled');
              return;
            }
            await setEnabled(source.id, true, signal);
          }
          catch (error) {
            if (!intents.has(source.id))
              publish(source.id, 'failed', error instanceof Error ? error.message : '安装目录未能确认');
            /* 显式启停自行记录结果，单项失败不能阻断其他页面。 */
          }
        }));
        active(signal);
        return snapshot;
      })();
      return started;
    },
    setEnabled,
    dispose() {
      closed = true;
      catalog.dispose();
      for (const operation of operations.values()) operation.abort();
      operations.clear();
      void unsubscribe?.();
      listeners.clear();
    },
  };
}
export type OfficialPlugins = ReturnType<typeof createOfficialPlugins>;
