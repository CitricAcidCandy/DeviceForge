import { abortable } from '@deviceforge/business-kit/api';
import type { Dispose, HostContext, HostResult } from '@deviceforge/plugin-sdk';
import { createBrowserManagementClient } from '../browser-management.ts';
import { pluginsEndpoint, packagesEndpoint } from './api/index.ts';
import type { ApiClient, PackageInfo, PluginInfo } from './api/index.ts';
import { decodeBrowserCatalog } from './catalog-validation.ts';
import type { BrowserCatalogState } from './catalog-validation.ts';

export interface InstalledState {
  readonly browser: BrowserCatalogState | null;
  readonly serverPackages: readonly PackageInfo[];
  readonly serverPlugins: readonly PluginInfo[];
  readonly known: boolean; readonly pending: boolean; readonly error: unknown;
}
/** 市场视图自有观察，不接管宿主目录、不用新刷新取消别人的在途读取。 */
export function createInstalledCatalog(context: HostContext, api: ApiClient) {
  const browser = createBrowserManagementClient(context), lifetime = new AbortController();
  const listeners = new Set<(value: InstalledState) => void>();
  let state: InstalledState = { browser: null, serverPackages: [], serverPlugins: [], known: false, pending: false, error: null };
  let stop: Dispose | null = null, current: AbortController | null = null, generation = 0, observation = 0;
  let serverKnown = false;
  let reading: Promise<void> | null = null, dirty = false;
  function publish(next: InstalledState) {
    if (lifetime.signal.aborted || context.signal.aborted) return;
    state = Object.freeze(next);
    for (const listener of listeners) { try { listener(state); } catch { /* 独立观察者不阻断目录。 */ } }
  }
  async function snapshot() {
    if (reading) { dirty = true; return reading; }
    const signal = AbortSignal.any([lifetime.signal, context.signal, AbortSignal.timeout(15_000)]);
    const expected = ++observation;
    reading = abortable(Promise.resolve().then(() => browser.snapshot(signal)), signal).then((result) => {
      signal.throwIfAborted();
      if (expected !== observation) return;
      const value = decodeBrowserCatalog(result.data, result.logId);
      publish({ ...state, browser: value, known: serverKnown && value.known && !state.pending, error: value.error });
    }).catch((error: unknown) => {
      if (!lifetime.signal.aborted && !context.signal.aborted && expected === observation)
        publish({ ...state, known: false, error });
    })
      .finally(() => {
        reading = null;
        if (dirty && !signal.aborted) { dirty = false; void snapshot(); }
      });
    return reading;
  }
  function observe() {
    if (stop) return;
    stop = browser.subscribe(() => { void snapshot(); });
  }
  async function refresh(caller: AbortSignal) {
    current?.abort();
    current = new AbortController();
    const expected = ++generation, signal = AbortSignal.any([caller, context.signal, lifetime.signal, current.signal, AbortSignal.timeout(15_000)]);
    observation++;
    publish({ ...state, pending: true, known: false, error: null });
    try {
      signal.throwIfAborted();
      observe();
      const [directory, serverPackages, serverPlugins] = await abortable(Promise.all([
        browser.refresh(signal), api.call(packagesEndpoint, 'server', signal), api.call(pluginsEndpoint, undefined, signal),
      ]), signal);
      signal.throwIfAborted();
      if (expected !== generation) return;
      const value = decodeBrowserCatalog(directory.data, directory.logId);
      serverKnown = true; observation++;
      publish({ browser: value, serverPackages: serverPackages.data, serverPlugins: serverPlugins.data,
        known: value.known, pending: false, error: value.error });
    } catch (error) {
      if (expected === generation && !signal.aborted) {
        serverKnown = false; observation++;
        publish({ ...state, pending: false, known: false, error });
      }
      throw error;
    } finally {
      if (expected === generation) {
        current = null;
        if (state.pending) publish({ ...state, pending: false });
      }
    }
  }
  return {
    snapshot: () => state,
    subscribe(listener: (value: InstalledState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    async refreshServer(signal: AbortSignal): Promise<HostResult<readonly PluginInfo[]>> {
      const result = await api.call(pluginsEndpoint, undefined, signal);
      publish({ ...state, serverPlugins: result.data }); return result;
    },
    async refreshBrowser(signal: AbortSignal) {
      const currentSignal = AbortSignal.any([signal, context.signal, lifetime.signal, AbortSignal.timeout(15_000)]);
      const result = await abortable(browser.refresh(currentSignal), currentSignal);
      currentSignal.throwIfAborted();
      const value = decodeBrowserCatalog(result.data, result.logId);
      observation++;
      publish({ ...state, browser: value, known: serverKnown && value.known && !state.pending, error: value.error }); return value;
    },
    async dispose() {
      lifetime.abort(); current?.abort(); current = null; generation++; listeners.clear();
      const release = stop; stop = null;
      if (release) await abortable(Promise.resolve(release()), AbortSignal.timeout(5000));
    },
  };
}
