import { ApiError } from '../api/index.ts';
import type { Endpoint } from '../api/index.ts';
import { isSchemaValue } from '../../utils/schema.ts';
import type { SchemaValue } from '../../utils/schema.ts';
import { createChannel } from './channel.ts';
import { readRealtimeEnvelope, realtimeFailure, record } from './envelope.ts';
import { createSocketManager } from './socket-manager.ts';
import type { RealtimeChannel, RealtimeManager, RealtimeNamespace, RealtimeOptions, RealtimeState } from './types.ts';

const capabilities: Endpoint<void, SchemaValue> = {
  request: () => ({ path: '/api/v2/realtime/capabilities', method: 'GET' }), decode: isSchemaValue,
};
/** 每个宿主运行实例持有一个管理器，各业务只持有可撤销的命名空间租约。 */
export function createRealtimeClient(options: RealtimeOptions) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const budget = { bytes: 0, requests: 0 };
  const channels = new Map<RealtimeNamespace, { channel: ReturnType<typeof createChannel>; refs: number }>();
  let probing: Promise<boolean> | null = null;
  let manager: Promise<RealtimeManager> | null = null;
  let managerScope: AbortController | null = null;
  const reconnectMs = options.reconnectMs ?? 60000;
  if (!Number.isSafeInteger(reconnectMs) || reconnectMs < 1 || reconnectMs > 60000)
    throw new Error('实时恢复窗口必须在 1 至 60000 毫秒之间');
  function probe(): Promise<boolean> {
    if (probing) return probing;
    const current = (async () => {
      try {
        const result = await options.client.call(capabilities, undefined, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
        const data = result.data;
        if (!record(data) || data.protocol_version !== 1 ||
            data.path !== '/api/v2/realtime/socket.io' || !Array.isArray(data.namespaces))
          throw realtimeFailure('realtime_unsupported_protocol', '服务器实时协议与当前客户端不兼容');
        const namespaces = data.namespaces;
        if (!['/debugger', '/tasks'].every(item => namespaces.some(value =>
          value === item || (record(value) && value.name === item))))
          throw realtimeFailure('realtime_unsupported_protocol', '服务器未公开所需实时命名空间');
        return true;
      } catch (error) {
        // 只有明确的旧宿主能力缺失才降级，网络未知不能启动第二条调试桥。
        if (error instanceof ApiError && [404, 405, 501].includes(error.status ?? 0)) return false;
        throw error;
      }
    })();
    probing = current;
    void current.catch(() => { if (probing === current) probing = null; });
    return current;
  }
  function getManager(): Promise<RealtimeManager> {
    if (manager) return manager;
    const scope = new AbortController(); managerScope = scope;
    const currentSignal = AbortSignal.any([signal, scope.signal]);
    manager = new Promise<RealtimeManager>((resolve, reject) => {
      let done = false;
      const finish = (value: RealtimeManager | null, error?: unknown) => {
        if (done) { value?.dispose(); return; }
        done = true; clearTimeout(timer); currentSignal.removeEventListener('abort', abort);
        if (value) resolve(value); else reject(error);
      };
      const abort = () => finish(null, new ApiError('cancelled', 'cancelled', '实时客户端加载已撤销'));
      const timer = setTimeout(() => {
        finish(null, realtimeFailure('realtime_load_timeout', '实时客户端加载超时，普通业务仍可继续'));
        scope.abort();
      }, 5000);
      currentSignal.addEventListener('abort', abort, { once: true });
      if (currentSignal.aborted) { abort(); return; }
      void Promise.resolve().then(() => (options.factory ?? createSocketManager)({
        baseUrl: options.baseUrl, signal: currentSignal,
        ...(options.tokenProvider ? { tokenProvider: options.tokenProvider } : {}),
      })).then(value => finish(value), error => finish(null, error));
    });
    return manager;
  }
  function dropManager() {
    managerScope?.abort(); managerScope = null;
    const previous = manager; manager = null;
    void previous?.then(value => value.dispose(), () => {});
  }
  function acquire(namespace: RealtimeNamespace): RealtimeChannel {
    signal.throwIfAborted();
    let entry = channels.get(namespace);
    if (!entry) {
      entry = { refs: 0, channel: createChannel(namespace, {
        signal, manager: getManager, supported: probe, budget, reconnectMs,
      }) };
      channels.set(namespace, entry);
    }
    entry.refs++;
    const owner = entry, lease = new AbortController(), releases = new Set<() => void>();
    const track = (release: () => void) => { releases.add(release); return () => { releases.delete(release); release(); }; };
    return {
      supported: owner.channel.supported,
      connected: () => !lease.signal.aborted && owner.channel.connected(),
      subscribe: listener => lease.signal.aborted ? () => {} : track(owner.channel.subscribe(listener)),
      on: (event, listener) => lease.signal.aborted ? () => {} : track(owner.channel.on(event, listener)),
      request: (event, value, caller, timeout) => owner.channel.request(event, value,
        AbortSignal.any([lease.signal, caller]), timeout),
      reconnect: () => { if (!lease.signal.aborted) owner.channel.reconnect(); },
      release() {
        if (lease.signal.aborted) return;
        lease.abort(); for (const release of releases) release(); releases.clear();
        owner.refs--;
        if (!owner.refs && channels.get(namespace) === owner) { owner.channel.dispose(); channels.delete(namespace); }
        if (!channels.size) dropManager();
      },
    };
  }
  function dispose() {
    if (lifetime.signal.aborted) return;
    lifetime.abort(); for (const entry of channels.values()) entry.channel.dispose(); channels.clear(); dropManager();
    options.signal.removeEventListener('abort', dispose);
  }
  options.signal.addEventListener('abort', dispose, { once: true });
  if (options.signal.aborted) dispose();
  return {
    acquire,
    subscribeTasks(listener: (state: RealtimeState) => void) {
      const channel = acquire('/tasks');
      const notify = (state: RealtimeState) => { try { listener(state); } catch { /* 观察者不改变连接归属。 */ } };
      channel.on('tasks:changed', value => {
        try {
          const data = readRealtimeEnvelope(value);
          if (!record(data) || typeof data.revision !== 'string' || data.revision.length > 128 || typeof data.reset !== 'boolean')
            throw realtimeFailure('realtime_invalid_revision', '任务通知修订无效');
          notify({ state: 'changed', revision: data.revision, reset: data.reset });
        } catch { notify({ state: 'unavailable', revision: null, reset: true }); }
      });
      channel.subscribe(notify);
      void channel.supported.catch(() => notify({ state: 'unavailable', revision: null, reset: true }));
      return () => channel.release();
    },
    dispose,
  };
}
export type RealtimeClient = ReturnType<typeof createRealtimeClient>;
