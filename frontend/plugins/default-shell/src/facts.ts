import type { Dispose, HostContext, JsonValue, ServiceRef } from '@deviceforge/plugin-sdk';
import { loadedPluginCount, serviceEndpoint, waiting } from './facts-rules.ts';
import type { ShellFacts, ShellObservation } from './facts-rules.ts';

let sequence = 0;
async function observed<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let remove = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new Error('运行状态读取已取消或超时'));
    signal.addEventListener('abort', abort, { once: true });
    remove = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return request(); }), cancelled]);
  } finally { remove(); }
}
/** 只消费现有公开事实；服务缺失不影响外壳、导航或其他功能。 */
export function createShellFacts(context: HostContext, timeoutMs = 5_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('运行状态读取期限无效');
  const identity = ++sequence, lifetime = new AbortController(), listeners = new Set<() => void>();
  const releases: Dispose[] = [], refreshers = new Set<() => void>();
  let started = false, disposal: Promise<void> | null = null;
  let state: ShellFacts = Object.freeze({ endpoint: waiting<string>(), plugins: waiting<number>() });
  function publish<K extends keyof ShellFacts>(key: K, value: ShellFacts[K]) {
    if (lifetime.signal.aborted || context.signal.aborted) return;
    state = Object.freeze({ ...state, [key]: value });
    for (const listener of [...listeners]) { try { listener(); } catch { /* 独立观察者不能阻断其他事实。 */ } }
  }
  function feature<K extends keyof ShellFacts, T extends string | number>(
    key: K, ref: ServiceRef, action: string, decode: (value: JsonValue) => T,
    update: (value: ShellObservation<T>) => void, event?: string,
  ) {
    const access = context.services;
    if (!access) return;
    releases.push(access.whenAvailable(`shell.facts.${identity}.${key}`, [ref], (host) => {
      const owner = new AbortController();
      const signal = AbortSignal.any([owner.signal, lifetime.signal, host.signal]);
      let pending = false, queued = false;
      let observation = waiting<T>();
      async function read() {
        if (signal.aborted) return;
        if (pending) { queued = true; return; }
        pending = true;
        observation = { ...observation, state: observation.value === null ? 'loading' : 'stale' };
        update(observation);
        const caller = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
        try {
          const result = await observed(() => {
            if (!host.services) throw new Error('运行状态服务已撤销');
            return host.services.call(ref, { action }, caller);
          }, caller);
          if (signal.aborted) return;
          observation = { value: decode(result.data), state: 'confirmed', error: null, logId: result.logId };
        } catch (error) {
          if (signal.aborted) return;
          observation = { ...observation, state: observation.value === null ? 'failed' : 'stale',
            error: error instanceof Error ? error.message : '运行状态读取失败',
            logId: error && typeof error === 'object' && 'logId' in error && typeof error.logId === 'string' ? error.logId : null };
        } finally {
          pending = false;
          if (!signal.aborted) {
            update(observation);
            if (queued) { queued = false; void read(); }
          }
        }
      }
      const refresh = () => { void read(); };
      refreshers.add(refresh);
      const unsubscribe = event ? host.extensions?.subscribeEvent(event, refresh) : undefined;
      void read();
      return async () => {
        owner.abort(); queued = false; refreshers.delete(refresh);
        update(waiting());
        await unsubscribe?.();
      };
    }));
  }
  async function dispose() {
    if (disposal) return disposal;
    lifetime.abort(); listeners.clear(); refreshers.clear();
    context.signal.removeEventListener('abort', onAbort);
    disposal = Promise.allSettled(releases.splice(0).map((release) => Promise.resolve().then(release))).then((results) => {
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, '外壳运行状态订阅未完全释放');
    });
    return disposal;
  }
  const onAbort = () => { void dispose().catch(() => undefined); };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) onAbort();
  return {
    snapshot: () => state,
    subscribe(listener: () => void): Dispose { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (started || lifetime.signal.aborted) return;
      started = true;
      feature('endpoint', { id: 'host.connection', version: '1' }, 'status', serviceEndpoint, (value) => publish('endpoint', value));
      feature('plugins', { id: 'host.browser-plugins', version: '1' }, 'snapshot', loadedPluginCount,
        (value) => publish('plugins', value), 'host.browser-plugins.changed');
    },
    refresh() { for (const refresh of refreshers) refresh(); }, dispose,
  };
}
