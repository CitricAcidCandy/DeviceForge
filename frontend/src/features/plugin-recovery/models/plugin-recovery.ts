import { ApiError, pluginRecoveryEndpoint, recoverPluginEndpoint } from '../../../services/api/index.ts';
import type { ApiClient, ApiResult, PluginRecoveryView } from '../../../services/api/index.ts';
import type { PluginRecoverySnapshot, RecoveryTarget } from '../types/index.ts';

const cancelled = () => new ApiError('cancelled', 'cancelled', '已停止等待核对结果，服务器处理不保证回滚');
const empty = (target: RecoveryTarget | null): PluginRecoverySnapshot => ({
  target, phase: 'idle', result: null, error: null, unavailable: false, cancelled: false, reportTarget: null,
});

export function createPluginRecovery(client: ApiClient, id: string) {
  let state = empty(null);
  let closed = false;
  let request: { controller: AbortController; target: RecoveryTarget; kind: 'reading' | 'recovering'; posted: boolean; rechecked: boolean } | null = null;
  const listeners = new Set<(value: PluginRecoverySnapshot) => void>();
  function publish(next: PluginRecoverySnapshot): void {
    if (closed) return;
    state = next;
    for (const listener of listeners) listener(state);
  }
  function stop(): void {
    const previous = request;
    request = null;
    previous?.controller.abort();
  }
  function accept(result: ApiResult<PluginRecoveryView>, generation?: string): ApiResult<PluginRecoveryView> {
    if (result.data.id !== id || (generation !== undefined && result.data.generation !== generation))
      throw new ApiError('protocol', 'invalid_response', '核对结果的插件身份或代际已变化，请重新读取状态', 200, result.logId);
    return result;
  }
  async function run(kind: 'reading' | 'recovering', signal: AbortSignal, preserveCancelled = false): Promise<ApiResult<PluginRecoveryView> | null> {
    if (closed || signal.aborted) throw cancelled();
    const target = state.target;
    if (!target) throw new ApiError('http', 'target_required', '投屏恢复入口暂不可用，请重新进入页面');
    if (request) throw new ApiError('http', 'busy', '正在读取或核对恢复状态，请等待本次结果');
    const current = { controller: new AbortController(), target, kind, posted: false, rechecked: false };
    request = current;
    const combined = AbortSignal.any([signal, current.controller.signal]);
    const valid = () => !closed && request === current && state.target?.key === target.key;
    const guard = () => { if (!valid() || combined.aborted) throw cancelled(); };
    publish({ ...state, phase: kind, error: null, cancelled: preserveCancelled });
    try {
      // 每次主动恢复都重新 GET 取代际，不使用上次页面快照提交 POST。
      let result = accept(await client.call(pluginRecoveryEndpoint, id, combined));
      guard();
      let reportTarget: string | null = null;
      if (kind === 'recovering' && result.data.supported && !result.data.recovering) {
        current.posted = true;
        const generation = result.data.generation;
        result = accept(await client.call(recoverPluginEndpoint, {
          id, body: { generation, input: target.deviceId === undefined ? {} : { device_id: target.deviceId } },
        }, combined), generation);
        guard();
        reportTarget = target.key;
      }
      publish({ ...state, phase: 'idle', result, reportTarget,
        error: null, unavailable: false, cancelled: preserveCancelled });
      return result;
    } catch (error) {
      if (valid()) {
        const isCancelled = combined.aborted || error instanceof ApiError && error.kind === 'cancelled';
        const unavailable = error instanceof ApiError && error.status === 404;
        let observed: ApiResult<PluginRecoveryView> | null = null;
        if (current.posted && !isCancelled && !unavailable) {
          current.rechecked = true;
          try {
            observed = accept(await client.call(pluginRecoveryEndpoint, id, combined));
            guard();
          } catch {
            // 重查失败不覆盖原始 POST 错误与日志，也不重发恢复。
          }
        }
        if (valid()) publish({ ...state, phase: 'idle', result: observed, reportTarget: null,
          error: isCancelled || combined.aborted ? null : error, unavailable,
          cancelled: isCancelled || combined.aborted || preserveCancelled });
      }
      if (error instanceof ApiError && error.status === 404 && valid()) return null;
      throw error;
    } finally {
      if (valid()) {
        request = null;
        // POST 取消等待后只读一次真实状态，绝不重发恢复或投屏动作。
        if (combined.aborted && current.posted && !current.rechecked)
          void refresh(new AbortController().signal, true).catch(() => undefined);
      }
    }
  }
  const refresh = (signal: AbortSignal, preserveCancelled = false) => run('reading', signal, preserveCancelled);
  return {
    setTarget(target: RecoveryTarget | null) {
      if (closed || state.target?.key === target?.key && state.target?.deviceId === target?.deviceId) return;
      stop();
      publish(empty(target));
    },
    refresh,
    recover: (signal: AbortSignal) => run('recovering', signal),
    async prepareOpen(signal: AbortSignal): Promise<void> {
      if (closed || signal.aborted) throw cancelled();
      const targetKey = state.target?.key;
      if (!targetKey) throw new ApiError('http', 'target_required', '投屏恢复入口暂不可用，请重新进入页面');
      if (request?.kind === 'recovering' || state.result?.data.recovering)
        throw new ApiError('http', 'busy', '服务器正在核对投屏资源，请稍后读取状态再打开', 409, state.result?.logId ?? null);
      // 已有页面状态查询时不叠加请求；恢复接口不是正常投屏的额外准入依赖。
      if (request?.kind === 'reading') return;
      let result: ApiResult<PluginRecoveryView> | null;
      try { result = await refresh(signal); }
      catch {
        if (signal.aborted || closed || state.target?.key !== targetKey) throw cancelled();
        return;
      }
      // 这里只读准备；资源核对由宿主的新会话准入执行一次，避免双重自动恢复。
      if (result?.data.recovering)
        throw new ApiError('http', 'busy', '服务器正在核对投屏资源，请稍后读取状态再打开', 409, result.logId);
    },
    cancel() {
      const posted = request?.posted && !request.rechecked;
      const target = state.target;
      stop();
      publish({ ...state, phase: 'idle', result: null, reportTarget: null, error: null, cancelled: true });
      if (posted && target) void refresh(new AbortController().signal, true).catch(() => undefined);
    },
    snapshot: () => state,
    subscribe(listener: (value: PluginRecoverySnapshot) => void) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      stop();
      closed = true;
      listeners.clear();
    },
  };
}
