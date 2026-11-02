import { useEffect, useState } from 'react';
import type { Dispose, HostContext, Operation } from '@deviceforge/plugin-sdk';

const empty: ReadonlyMap<string, string> = new Map();

/** 名称目录仅改善可读性；不可用时保留真实操作标识，不影响任务结果。 */
export function useTaskOperationTitles(context: HostContext, open: boolean): ReadonlyMap<string, string> {
  const [titles, setTitles] = useState(empty);
  useEffect(() => {
    setTitles(empty);
    if (!open || context.signal.aborted) return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, context.signal, AbortSignal.timeout(5_000)]);
    let received = false;
    const accept = (operations: readonly Operation[]) => {
      if (lifetime.signal.aborted || context.signal.aborted) return;
      received = true;
      setTitles(new Map(operations.map((entry) => [entry.id, entry.title])));
    };
    let release: Dispose = () => {};
    try { release = context.subscribeOperations(accept); }
    catch { /* 可选名称观测失败时继续显示真实操作标识。 */ }
    if (!received) {
      void Promise.resolve().then(() => {
        signal.throwIfAborted();
        return context.listOperations(signal);
      }).then((result) => {
        // 实时目录优先于较早发出的读取，不让迟到快照覆盖新名称。
        if (!received && !signal.aborted) accept(result.data);
      }).catch(() => undefined);
    }
    return () => { lifetime.abort(); void Promise.resolve().then(release).catch(() => undefined); };
  }, [context, open]);
  return titles;
}
