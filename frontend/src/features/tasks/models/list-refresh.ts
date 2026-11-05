import type { Dispose, TaskHistoryAccess, TaskHistoryChange } from '../../../plugin-sdk/index.ts';

export interface TaskListRefreshOptions {
  readonly read: (signal: AbortSignal) => Promise<unknown>;
  readonly onError: (error: unknown) => void;
  readonly subscribeChanges?: NonNullable<TaskHistoryAccess['subscribeChanges']>;
  readonly canPoll?: () => boolean;
  readonly intervalMs: number;
  readonly timeoutMs?: number;
}

/** 只编排注入的读取和订阅；不创建网络连接，不取消仍有用的在途快照。 */
export function createTaskListRefresh(options: TaskListRefreshOptions) {
  let interval = options.intervalMs;
  const timeout = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(interval) || interval < 1 || !Number.isFinite(timeout) || timeout < 1)
    throw new Error('任务列表刷新间隔和等待期限无效');
  let closed = false, started = false, initializing = false, healthy = false, synchronized = false, dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let unsubscribe: Dispose | undefined;
  const report = (error: unknown) => {
    if (!closed) try { options.onError(error); } catch { /* 消费者错误不传播到实时通知处理器。 */ }
  };
  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    clearTimer();
    if (closed || !started || healthy && synchronized || current) return;
    timer = setTimeout(() => {
      timer = null;
      if (options.canPoll?.() === false) schedule();
      else void refresh();
    }, interval);
  }
  async function read() {
    const request = new AbortController();
    controller = request;
    const deadline = setTimeout(() => request.abort(new Error('任务列表读取超时')), timeout);
    try {
      await new Promise<unknown>((resolve, reject) => {
        const aborted = () => reject(request.signal.reason);
        request.signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve().then(() => {
          request.signal.throwIfAborted();
          return options.read(request.signal);
        }).then(resolve, reject).finally(() => request.signal.removeEventListener('abort', aborted));
      });
      synchronized = true;
    } catch (error) { synchronized = false; report(error); }
    finally {
      clearTimeout(deadline);
      if (controller === request) controller = null;
    }
  }
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    dirty = true;
    if (current) return current;
    clearTimer();
    current = Promise.resolve().then(async () => {
      while (dirty && !closed) {
        dirty = false;
        await read();
      }
    }).finally(() => {
      current = null;
      // 完成微任务与通知竞争时，最后一次变化仍要有后续读取。
      if (dirty && !closed) void refresh();
      else schedule();
    });
    return current;
  }
  function changed(change: TaskHistoryChange) {
    if (closed) return;
    healthy = change.state !== 'unavailable';
    if (healthy) {
      synchronized = false;
      clearTimer();
      if (!initializing) void refresh();
    } else schedule();
  }
  return {
    refresh,
    start() {
      if (closed || started) return;
      started = true;
      initializing = true;
      try { unsubscribe = options.subscribeChanges?.(changed); }
      catch (error) { healthy = false; report(error); }
      finally { initializing = false; }
      if (closed) {
        try { void Promise.resolve(unsubscribe?.()).catch(() => undefined); } catch { /* 局部回收。 */ }
        unsubscribe = undefined;
      } else void refresh();
    },
    setIntervalMs(value: number) {
      if (!Number.isFinite(value) || value < 1) throw new Error('任务列表刷新间隔无效');
      interval = value;
      schedule();
    },
    dispose() {
      if (closed) return;
      closed = true;
      dirty = false;
      clearTimer();
      controller?.abort();
      try { void Promise.resolve(unsubscribe?.()).catch(() => undefined); } catch { /* 局部回收。 */ }
      unsubscribe = undefined;
    },
  };
}
