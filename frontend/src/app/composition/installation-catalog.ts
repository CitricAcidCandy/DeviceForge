import type { Dispose } from '../../plugin-sdk/index.ts';
import { awaitLifecycle } from '../../plugins/lifecycle.ts';
import type { ResourceSnapshot } from '../../shared/lifecycle/latest.ts';
import type { PlatformRuntime } from '../platform-runtime.ts';

const waitMs = 15_000;
type CatalogRuntime = Pick<PlatformRuntime,
  'pluginPackages' | 'pluginInstallations' | 'host'>;
interface Directory {
  readonly snapshot: () => ResourceSnapshot<unknown>;
  readonly contains: (id: string) => boolean;
  readonly subscribe: (listener: () => void) => Dispose;
  readonly refresh: (signal: AbortSignal) => Promise<unknown>;
}

/** 只核对现有目录：未知不等于空，已有读取由原所有者管理。 */
export function createInstallationCatalog(runtime: CatalogRuntime) {
  const lifetime = new AbortController();
  const readers = new Map<AbortController, () => void>();
  const directories: readonly Directory[] = [{
    snapshot: () => runtime.pluginPackages.snapshot('browser'),
    contains: (id) => runtime.pluginPackages.snapshot('browser').result?.data
      .some((entry) => entry.id === id) ?? false,
    subscribe: (listener) => runtime.pluginPackages.subscribe('browser', listener),
    refresh: (signal) => runtime.pluginPackages.refresh('browser', signal),
  }, {
    snapshot: runtime.pluginInstallations.snapshot,
    contains: (id) => runtime.pluginInstallations.snapshot().result?.data.some((entry) =>
      entry.components.some((component) => component.kind === 'browser' && component.id === id)) ?? false,
    subscribe: runtime.pluginInstallations.subscribe,
    refresh: runtime.pluginInstallations.refresh,
  }];
  function status(id: string): 'external' | 'absent' | 'unknown' {
    if (directories.some((directory) => directory.contains(id))) return 'external';
    return directories.every((directory) => {
      const state = directory.snapshot();
      return !state.pending && state.result !== null && state.error === null;
    }) ? 'absent' : 'unknown';
  }
  function read(directory: Directory, notify: () => void) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal, runtime.host.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', release);
      readers.delete(controller);
    };
    const cancel = () => { release(); controller.abort(); };
    readers.set(controller, cancel);
    signal.addEventListener('abort', release, { once: true });
    if (signal.aborted) { cancel(); return; }
    timer = setTimeout(cancel, waitMs);
    // refresh 同步公布 pending；其他调用通过订阅共享它，不会再次刷新撤销本次读取。
    try {
      void directory.refresh(signal).then(notify, notify).finally(release).catch(() => undefined);
    } catch (error) {
      cancel();
      throw error;
    }
  }
  async function inspect(id: string, signal: AbortSignal): Promise<boolean> {
    const combined = AbortSignal.any([signal, lifetime.signal, runtime.host.signal]);
    const releases: Dispose[] = [];
    try {
      return await awaitLifecycle(() => new Promise<boolean>((resolve, reject) => {
        const observed = new Set<Directory>();
        let settled = false, checking = false;
        const finish = (error: unknown, external?: boolean) => {
          if (settled) return;
          settled = true;
          if (external === undefined) reject(error);
          else resolve(external);
        };
        const update = () => {
          if (settled || checking || combined.aborted) return;
          checking = true;
          try {
            const current = status(id);
            if (current !== 'unknown') { finish(null, current === 'external'); return; }
            for (const directory of directories) {
              const state = directory.snapshot();
              if (state.pending) { observed.add(directory); continue; }
              if (state.result !== null && state.error === null) continue;
              if (observed.has(directory)) {
                finish(state.error ?? new Error('安装目录尚未确认，不能启停随附插件'));
                return;
              }
              observed.add(directory);
              read(directory, update);
            }
          } catch (error) { finish(error); }
          finally { checking = false; }
        };
        for (const directory of directories) releases.push(directory.subscribe(update));
        update();
      }), combined, Date.now() + waitMs, '安装目录确认');
    } finally {
      for (const release of releases) void release();
    }
  }
  return {
    status,
    inspect,
    dispose() {
      lifetime.abort();
      for (const cancel of readers.values()) cancel();
      readers.clear();
    },
  };
}
