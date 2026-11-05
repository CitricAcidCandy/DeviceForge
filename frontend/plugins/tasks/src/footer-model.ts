import { HostError } from '@deviceforge/plugin-sdk';
import type { Dispose, HistoricalJob, HostContext, TaskHistoryChange } from '@deviceforge/plugin-sdk';

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
  let started = false, initializing = false, healthy = false, synchronized = false, dirty = false;
  let waiting: Promise<void> | null = null;
  let unsubscribe: Dispose | undefined;
  let state: TaskFooterState = Object.freeze({ pending: false, jobs: [], updatedAt: null, error: null, logId: null });
  function publish(next: TaskFooterState) {
    if (lifetime.signal.aborted || context.signal.aborted) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个观察者不阻断状态更新。 */ }
    }
  }
  const closed = () => lifetime.signal.aborted || context.signal.aborted;
  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    clearTimer();
    if (started && !closed() && !(healthy && synchronized) && !waiting)
      timer = setTimeout(() => { timer = null; void refresh(); }, interval);
  }
  async function read() {
    const controller = new AbortController();
    current = controller;
    const deadline = new AbortController();
    const timeoutTimer = setTimeout(() => deadline.abort(), timeout);
    const signal = AbortSignal.any([controller.signal, lifetime.signal, context.signal, deadline.signal]);
    publish({ ...state, pending: true });
    try {
      if (!context.taskHistory) throw new HostError('protocol', 'task_history_unavailable', '当前宿主未提供公开任务历史');
      const result = await bounded(context.taskHistory.list({ limit: 200 }, signal), signal);
      if (signal.aborted || closed()) return;
      synchronized = true;
      publish({ pending: false, jobs: Object.freeze([...result.data]), updatedAt: Date.now(), error: null, logId: result.logId });
    } catch (error) {
      if (controller.signal.aborted || closed()) return;
      synchronized = false;
      publish({ ...state, pending: false, error: error instanceof Error ? error.message : '任务状态读取失败', logId: error instanceof HostError ? error.logId ?? state.logId : state.logId });
    } finally {
      clearTimeout(timeoutTimer);
      if (current === controller) current = null;
    }
  }
  function refresh(): Promise<void> {
    if (closed()) return Promise.resolve();
    dirty = true;
    if (waiting) return waiting;
    clearTimer();
    waiting = Promise.resolve().then(async () => {
      while (dirty && !closed()) {
        dirty = false;
        await read();
      }
    }).finally(() => {
      waiting = null;
      if (dirty && !closed()) void refresh();
      else schedule();
    });
    return waiting;
  }
  function changed(change: TaskHistoryChange) {
    if (closed()) return;
    healthy = change.state !== 'unavailable';
    if (healthy) {
      synchronized = false;
      clearTimer();
      if (!initializing) void refresh();
    } else schedule();
  }
  function releaseSubscription() {
    const release = unsubscribe;
    unsubscribe = undefined;
    try { void Promise.resolve(release?.()).catch(() => undefined); }
    catch { /* 单个宿主订阅释放失败不能留下本地定时器和请求。 */ }
  }
  function dispose() {
    if (lifetime.signal.aborted) return;
    lifetime.abort(); current?.abort(); dirty = false;
    clearTimer(); releaseSubscription(); listeners.clear();
    context.signal.removeEventListener('abort', dispose);
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (!closed()) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      if (started || closed()) return;
      started = true;
      initializing = true;
      try { unsubscribe = context.taskHistory?.subscribeChanges?.(changed); }
      catch (error) {
        healthy = false;
        publish({ ...state, error: error instanceof Error ? error.message : '任务变更订阅失败' });
      } finally { initializing = false; }
      if (closed()) releaseSubscription();
      else void refresh();
    },
    refresh, dispose,
  };
}
