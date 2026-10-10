import { ApiError } from '../api/errors.ts';
import type { ApiResult } from '../api/types.ts';

export interface ResourceSnapshot<T> {
  readonly pending: boolean;
  readonly result: ApiResult<T> | null;
  readonly error: unknown;
}
export function createLatestResource<T>() {
  let generation = 0;
  let closed = false;
  let active: AbortController | null = null;
  let snapshot: ResourceSnapshot<T> = { pending: false, result: null, error: null };
  const listeners = new Set<{ notify: (snapshot: ResourceSnapshot<T>) => void }>();
  function publish(next: ResourceSnapshot<T>, current: number) {
    if (closed || current !== generation) return;
    snapshot = next;
    // 一个订阅失败不能阻止其他订阅或改变请求结果。
    for (const listener of [...listeners]) {
      // 订阅可同步发起新读取或销毁资源，旧通知必须在此停止。
      if (closed || current !== generation || snapshot !== next) break;
      if (!listeners.has(listener)) continue;
      try { listener.notify(next); } catch { /* 订阅由调用者自主管理。 */ }
    }
  }
  async function run(request: (signal: AbortSignal) => Promise<ApiResult<T>>, signal: AbortSignal): Promise<ApiResult<T>> {
    if (closed || signal.aborted) throw new ApiError('cancelled', 'cancelled', '资源已关闭或等待已取消');
    const current = ++generation;
    const previous = active;
    const controller = new AbortController();
    active = controller;
    const combined = AbortSignal.any([controller.signal, signal]);
    const ensureCurrent = () => {
      if (closed || combined.aborted || current !== generation) throw new ApiError('cancelled', 'stale_result', '晚到结果已撤销');
    };
    previous?.abort();
    try {
      ensureCurrent();
      publish({ ...snapshot, pending: true, error: null }, current);
      ensureCurrent();
      const result = await request(combined);
      ensureCurrent();
      publish({ pending: false, result, error: null }, current);
      // 成功快照接受后仅取消等待不撤回它；新读取或销毁仍撤销旧交付。
      if (closed || current !== generation) throw new ApiError('cancelled', 'stale_result', '晚到结果已撤销');
      return result;
    } catch (error) {
      if (!closed && current === generation) publish({ ...snapshot, pending: false, error }, current);
      throw error;
    } finally { if (active === controller) active = null; }
  }
  return {
    run,
    snapshot: () => snapshot,
    subscribe(listener: (snapshot: ResourceSnapshot<T>) => void): () => void {
      if (closed) throw new Error('资源已关闭');
      const subscription = { notify: listener };
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    dispose() {
      if (closed) return;
      closed = true; ++generation;
      const previous = active; active = null;
      listeners.clear(); snapshot = { ...snapshot, pending: false };
      previous?.abort();
    },
  };
}
