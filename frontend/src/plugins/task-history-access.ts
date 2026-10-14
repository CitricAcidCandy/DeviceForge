import type { HostResult, TaskHistoryAccess } from '../plugin-sdk/index.ts';
import { awaitActive } from './extensions/await-active.ts';

// 作用域合并信号并复核代次；等待器额外兼容忽略取消的旧宿主端口。
export function scopedTaskHistoryAccess(
  upstream: TaskHistoryAccess | undefined,
  call: <T>(
    request: (signal: AbortSignal) => Promise<HostResult<T>>,
    signal: AbortSignal,
  ) => Promise<HostResult<T>>,
): TaskHistoryAccess | undefined {
  if (!upstream) return undefined;
  const invoke = <T>(
    request: (signal: AbortSignal) => Promise<HostResult<T>>,
    caller: AbortSignal,
  ) => call((signal) => awaitActive(() => request(signal), signal), caller);
  return Object.freeze<TaskHistoryAccess>({
    list: (query, signal) => invoke((current) => upstream.list(query, current), signal),
    get: (id, signal) => invoke((current) => upstream.get(id, current), signal),
    events: (id, query, signal) => invoke((current) => upstream.events(id, query, current), signal),
  });
}
