import { HostError } from '@deviceforge/plugin-sdk';
import type { HistoricalJob, HostContext } from '@deviceforge/plugin-sdk';

export interface TaskFooterState {
  readonly pending: boolean;
  readonly jobs: readonly HistoricalJob[];
  readonly updatedAt: number | null;
  readonly error: string | null;
  readonly logId: string | null;
}
export function taskFooterCounts(jobs: readonly HistoricalJob[]) {
  return {
    running: jobs.filter((job) => job.status === 'running').length,
    queued: jobs.filter((job) => job.status === 'queued').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
  };
}
function bounded<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new HostError('cancelled', 'task_footer_cancelled', '任务状态读取等待已结束')); };
    if (signal.aborted) { void request.catch(() => undefined); aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    request.then((value) => {
      signal.removeEventListener('abort', aborted);
      if (!signal.aborted) resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted);
      if (!signal.aborted) reject(error);
    });
  });
}
/** 只读取最近任务状态，不提交、重放或取消后台业务。 */
export function createTaskFooterModel(context: HostContext, options: { intervalMs?: number; timeoutMs?: number } = {}) {
  const interval = options.intervalMs ?? 3_000, timeout = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(interval) || interval < 10 || !Number.isFinite(timeout) || timeout < 1)
    throw new Error('任务状态刷新间隔和等待期限无效');
  const lifetime = new AbortController(), listeners = new Set<() => void>();
  let current: AbortController | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  let revision = 0, started = false;
  let state: TaskFooterState = Object.freeze({ pending: false, jobs: [], updatedAt: null, error: null, logId: null });
  function publish(next: TaskFooterState) {
    if (lifetime.signal.aborted || context.signal.aborted) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个观察者不阻断状态更新。 */ }
    }
  }
  async function refresh() {
    if (lifetime.signal.aborted || context.signal.aborted) return;
    if (timer) clearTimeout(timer);
    current?.abort();
    const controller = new AbortController(); current = controller;
    const token = ++revision;
    const signal = AbortSignal.any([controller.signal, lifetime.signal, context.signal, AbortSignal.timeout(timeout)]);
    publish({ ...state, pending: true });
    try {
      if (!context.taskHistory) throw new HostError('protocol', 'task_history_unavailable', '当前宿主未提供公开任务历史');
      const result = await bounded(context.taskHistory.list({ limit: 200 }, signal), signal);
      if (signal.aborted || token !== revision) return;
      publish({ pending: false, jobs: Object.freeze([...result.data]), updatedAt: Date.now(), error: null, logId: result.logId });
    } catch (error) {
      if (controller.signal.aborted || token !== revision) return;
      publish({ ...state, pending: false, error: error instanceof Error ? error.message : '任务状态读取失败', logId: error instanceof HostError ? error.logId : null });
    } finally {
      if (token === revision) {
        current = null;
        if (started && !lifetime.signal.aborted && !context.signal.aborted)
          timer = setTimeout(() => { void refresh(); }, interval);
      }
    }
  }
  function dispose() {
    if (lifetime.signal.aborted) return;
    lifetime.abort(); current?.abort(); revision++;
    if (timer) clearTimeout(timer);
    timer = null; listeners.clear();
    context.signal.removeEventListener('abort', dispose);
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { if (!started) { started = true; void refresh(); } },
    refresh, dispose,
  };
}
