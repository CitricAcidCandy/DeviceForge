import type { DeviceAccess, DeviceRef, Dispose, HostContext, HostResult, Operation } from '@deviceforge/plugin-sdk';
import { abortable, apiError, ApiError } from './api/index.ts';
import type { JobGateway } from './jobs/index.ts';

export interface OperationSnapshot {
  readonly pending: boolean;
  readonly result: HostResult<readonly Operation[]> | null;
  readonly error: unknown;
}
export interface OperationSource {
  snapshot(): OperationSnapshot;
  subscribe(listener: (snapshot: OperationSnapshot) => void): Dispose;
  list(signal: AbortSignal): Promise<HostResult<readonly Operation[]>>;
  dispose(): void;
}
export function createOperationSource(context: HostContext): OperationSource {
  let state: OperationSnapshot = Object.freeze({ pending: false, result: null, error: null });
  const listeners = new Set<(snapshot: OperationSnapshot) => void>();
  const lifetime = new AbortController();
  let observation = new AbortController(), revision = 0;
  function publish(next: OperationSnapshot) {
    if (lifetime.signal.aborted || context.signal.aborted) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* 独立订阅者异常不阻断其他观察者。 */ }
    }
  }
  const release = context.subscribeOperations((operations) => {
    publish({ pending: false, result: { data: operations, logId: null }, error: null });
  });
  return {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async list(signal) {
      observation.abort();
      observation = new AbortController();
      const admitted = ++revision;
      const current = AbortSignal.any([signal, context.signal, lifetime.signal, observation.signal]);
      current.throwIfAborted();
      publish({ ...state, pending: true, error: null });
      try {
        const result = await abortable(context.listOperations(current), current);
        if (admitted !== revision) throw new ApiError('cancelled', 'stale_operations', '旧操作目录已撤销');
        publish({ pending: false, result, error: null });
        return result;
      } catch (error) {
        const failure = apiError(error);
        if (admitted === revision) publish({ pending: false, result: null, error: failure });
        throw failure;
      }
    },
    dispose() {
      lifetime.abort(); observation.abort(); revision++;
      void release(); listeners.clear();
    },
  };
}
export function createPublicGateway(context: HostContext): JobGateway {
  async function call<T>(request: Promise<T>): Promise<T> {
    try { return await request; } catch (error) { throw apiError(error); }
  }
  return {
    submit: (operation, input, signal) => call(context.submit(operation, input, signal)),
    getJob: (id, signal) => call(context.getJob(id, signal)),
    cancelJob: (id, signal) => call(context.cancelJob(id, signal)),
  };
}
export interface DeviceConsumer { readonly context: HostContext; readonly devices: DeviceAccess }

/** 始终绑定完整设备引用和能力观测，页面本地 ID 不单独作为归属证明。 */
export async function withSelectedDevice<T>(
  services: DeviceConsumer, signal: AbortSignal,
  run: (reference: DeviceRef, current: AbortSignal) => Promise<T>,
): Promise<T> {
  const initial = services.devices.snapshot();
  const reference = initial.selection;
  if (!reference || initial.selected?.state !== 'online') throw new Error('请先选择在线设备');
  const identity = JSON.stringify(reference), capabilities = JSON.stringify(initial.selected.capabilities);
  const changed = new AbortController();
  const release = services.devices.subscribe((next) => {
    if (JSON.stringify(next.selection) !== identity || next.selected?.state !== 'online' ||
        JSON.stringify(next.selected.capabilities) !== capabilities) changed.abort();
  });
  const current = AbortSignal.any([signal, services.context.signal, changed.signal]);
  try {
    current.throwIfAborted();
    return await abortable(run(reference, current), current);
  } finally { await release(); }
}
