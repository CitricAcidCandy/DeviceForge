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
  const listeners = new Set<(snapshot: ResourceSnapshot<T>) => void>();
  function publish(next: ResourceSnapshot<T>) {
    snapshot = next;
    // 一个订阅失败不能阻止其他订阅或改变请求结果。
    for (const listener of listeners) { try { listener(next); } catch { /* 订阅由调用者自主管理。 */ } }
  }
  async function run(request: (signal: AbortSignal) => Promise<ApiResult<T>>, signal: AbortSignal): Promise<ApiResult<T>> {
    if (closed || signal.aborted) throw new ApiError('cancelled', 'cancelled', '资源已关闭或等待已取消');
    const current = ++generation;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const combined = AbortSignal.any([controller.signal, signal]);
    publish({ ...snapshot, pending: true, error: null });
    try {
      const result = await request(combined);
      if (closed || combined.aborted || current !== generation) throw new ApiError('cancelled', 'stale_result', '晚到结果已撤销');
      publish({ pending: false, result, error: null });
      return result;
    } catch (error) {
      if (!closed && current === generation) publish({ ...snapshot, pending: false, error });
      throw error;
    } finally { if (active === controller) active = null; }
  }
  return {
    run,
    snapshot: () => snapshot,
    subscribe(listener: (snapshot: ResourceSnapshot<T>) => void): () => void {
      if (closed) throw new Error('资源已关闭');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() { closed = true; ++generation; active?.abort(); listeners.clear(); snapshot = { ...snapshot, pending: false }; },
  };
}
