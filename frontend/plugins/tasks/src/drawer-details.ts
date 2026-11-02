import { HostError } from '@deviceforge/plugin-sdk';
import type { HistoricalJob, HostContext, JobEvent } from '@deviceforge/plugin-sdk';

export interface TaskDetailsState {
  readonly pending: boolean;
  readonly id: string | null;
  readonly job: HistoricalJob | null;
  readonly events: readonly JobEvent[];
  readonly error: string | null;
  readonly logId: string | null;
}
const initial: TaskDetailsState = Object.freeze({ pending: false, id: null, job: null,
  events: Object.freeze([]), error: null, logId: null });

function bounded<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new HostError('cancelled', 'task_details_wait_ended', '任务明细读取等待已结束'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    request.then((value) => { signal.removeEventListener('abort', aborted); if (!signal.aborted) resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', aborted); if (!signal.aborted) reject(error); });
    if (signal.aborted) aborted();
  });
}
function errorLog(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'logId' in error && typeof error.logId === 'string'
    ? error.logId : null;
}

/** 只读历史记录与事件；结束本地等待不代表取消后台任务。 */
export function createTaskDetailsModel(context: HostContext, options: { timeoutMs?: number } = {}) {
  const timeout = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error('任务明细读取期限无效');
  const lifetime = new AbortController(), listeners = new Set<() => void>();
  let current: AbortController | null = null, revision = 0, state = initial;
  const publish = (next: TaskDetailsState) => {
    if (lifetime.signal.aborted || context.signal.aborted) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) { try { listener(); } catch { /* 单个观察者不阻断读取。 */ } }
  };
  function clear() {
    revision++; current?.abort(); current = null;
    publish(initial);
  }
  function dispose() {
    if (lifetime.signal.aborted) return;
    revision++; current?.abort(); current = null; lifetime.abort();
    state = Object.freeze({ ...state, pending: false }); listeners.clear();
    context.signal.removeEventListener('abort', dispose);
  }
  async function read(id: string) {
    if (lifetime.signal.aborted || context.signal.aborted) return;
    clear();
    if (typeof id !== 'string' || !id.trim() || id.trim() !== id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) {
      publish({ ...initial, error: '任务编号无效' }); return;
    }
    const controller = new AbortController(); current = controller;
    const token = ++revision;
    const deadline = AbortSignal.timeout(timeout);
    const signal = AbortSignal.any([controller.signal, lifetime.signal, context.signal, deadline]);
    publish({ ...initial, pending: true, id });
    try {
      if (!context.taskHistory) throw new HostError('protocol', 'task_history_unavailable', '宿主未提供公开任务历史');
      const [result, updates] = await bounded(Promise.all([
        context.taskHistory.get(id, signal), context.taskHistory.events(id, {}, signal),
      ]), signal);
      if (token !== revision || signal.aborted) return;
      if (typeof result.data?.id !== 'string' || result.data.id.toLowerCase() !== id.toLowerCase())
        throw new HostError('protocol', 'task_details_identity_mismatch', '任务明细归属不一致', result.logId);
      if (!Array.isArray(updates.data) || updates.data.some((event) =>
        typeof event?.jobId !== 'string' || event.jobId.toLowerCase() !== id.toLowerCase() || !Number.isSafeInteger(event.sequence) || event.sequence < 0 ||
        !Number.isFinite(event.timestamp) || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(event.status)))
        throw new HostError('protocol', 'task_events_identity_mismatch', '任务事件归属或结构不一致', updates.logId);
      publish({ pending: false, id, job: result.data, events: Object.freeze([...updates.data]), error: null, logId: result.logId });
    } catch (error) {
      if (token !== revision || lifetime.signal.aborted || context.signal.aborted) return;
      publish({ ...initial, id, error: deadline.aborted ? '任务明细读取超时，未改变后台任务状态'
        : error instanceof Error ? error.message : '任务明细读取失败', logId: errorLog(error) });
    } finally { if (token === revision) current = null; }
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (lifetime.signal.aborted) return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    read, clear, dispose,
  };
}
