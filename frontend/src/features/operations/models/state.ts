import { ApiError } from '../../../services/api/index.ts';
import type { ApiResult, OperationDto } from '../../../services/api/index.ts';
import type { ResourceSnapshot } from '../../../shared/lifecycle/latest.ts';

type OperationSnapshot = ResourceSnapshot<OperationDto[]>;

// 操作目录独立管理失效；不改变任务、插件包等功能的共享资源行为。
export function createOperationState() {
  let revision = 0;
  let closed = false;
  let active: AbortController | null = null;
  let snapshot: OperationSnapshot = { pending: false, result: null, error: null };
  const listeners = new Set<(snapshot: OperationSnapshot) => void>();
  const check = () => { if (closed) throw new ApiError('cancelled', 'cancelled', '操作目录已关闭，请求等待已取消'); };
  const empty = (): OperationSnapshot => ({ pending: false, result: { data: [], logId: null }, error: null });
  function publish(next: OperationSnapshot) {
    snapshot = next;
    for (const listener of listeners) {
      // 重入失效或刷新已发布新快照时，不继续向后续订阅者传播旧状态。
      if (snapshot !== next || closed) break;
      try { listener(next); } catch { /* 一个订阅失败不影响其他订阅或请求。 */ }
    }
  }
  async function refresh(request: (signal: AbortSignal) => Promise<ApiResult<OperationDto[]>>, signal: AbortSignal): Promise<ApiResult<OperationDto[]>> {
    check();
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '操作目录请求等待已取消');
    const current = ++revision;
    active?.abort();
    const controller = new AbortController(); active = controller;
    const combined = AbortSignal.any([signal, controller.signal]);
    publish({ ...snapshot, pending: true, error: null });
    try {
      const result = await request(combined);
      if (closed || combined.aborted || current !== revision) throw new ApiError('cancelled', 'stale_result', '旧操作目录响应已撤销');
      publish({ pending: false, result, error: null });
      if (closed || combined.aborted || current !== revision) throw new ApiError('cancelled', 'stale_result', '操作目录在订阅通知时已撤销');
      return result;
    } catch (error) {
      if (!closed && current === revision) publish({ ...snapshot, pending: false, error });
      throw error;
    } finally { if (active === controller) active = null; }
  }
  return {
    refresh,
    snapshot: () => snapshot,
    subscribe(listener: (snapshot: OperationSnapshot) => void): () => void {
      check(); listeners.add(listener); return () => { listeners.delete(listener); };
    },
    invalidate() {
      check(); ++revision; active?.abort(); active = null;
      // 空目录是本地撤销通知，没有服务器响应，不能沿用旧查询的日志 ID。
      publish(empty());
    },
    dispose() {
      closed = true; ++revision; active?.abort(); active = null;
      listeners.clear(); snapshot = empty();
    },
  };
}
