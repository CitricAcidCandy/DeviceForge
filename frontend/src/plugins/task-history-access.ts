import type { Dispose, HostResult, TaskHistoryAccess, TaskHistoryChange } from '../plugin-sdk/index.ts';
import { awaitActive } from './extensions/await-active.ts';

// 作用域合并信号并复核代次；等待器额外兼容忽略取消的旧宿主端口。
export function scopedTaskHistoryAccess(
  upstream: TaskHistoryAccess | undefined,
  call: <T>(
    request: (signal: AbortSignal) => Promise<HostResult<T>>,
    signal: AbortSignal,
  ) => Promise<HostResult<T>>,
  current: () => void,
  signal: AbortSignal,
  track: (release: Dispose) => Dispose,
): TaskHistoryAccess | undefined {
  if (!upstream) return undefined;
  const subscribeChanges = upstream.subscribeChanges;
  const invoke = <T>(
    request: (signal: AbortSignal) => Promise<HostResult<T>>,
    caller: AbortSignal,
  ) => call((signal) => awaitActive(() => request(signal), signal), caller);
  return Object.freeze<TaskHistoryAccess>({
    ...(subscribeChanges ? {
      subscribeChanges(listener: (change: TaskHistoryChange) => void): Dispose {
        current();
        let closed = false;
        let upstreamRelease: Dispose | undefined;
        let release: Dispose = () => {};
        const abort = () => { void release(); };
        const stop = () => {
          if (closed) return;
          closed = true;
          signal.removeEventListener('abort', abort);
          const previous = upstreamRelease;
          upstreamRelease = undefined;
          return previous?.();
        };
        // 先登记归属，兼容上游在返回释放句柄之前同步通知并关闭作用域。
        release = track(stop);
        if (closed) return release;
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { void release(); return release; }
        try {
          const handle = subscribeChanges.call(upstream, (change) => {
            if (closed || signal.aborted) return;
            try { current(); } catch { void release(); return; }
            try { listener(change); } catch { /* 单个消费者不能中断共享通知或其他订阅。 */ }
          });
          if (closed || signal.aborted) {
            // 同步通知已经触发回收，晚取得的句柄仍须纳入作用域异步排空。
            void track(handle)();
          } else upstreamRelease = handle;
        } catch (error) { void release(); throw error; }
        return release;
      },
    } : {}),
    list: (query, signal) => invoke((current) => upstream.list(query, current), signal),
    get: (id, signal) => invoke((current) => upstream.get(id, current), signal),
    events: (id, query, signal) => invoke((current) => upstream.events(id, query, current), signal),
  });
}
