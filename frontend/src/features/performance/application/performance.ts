import { HostError } from '../../../plugin-sdk/index.ts';
import type { JsonValue } from '../../../plugin-sdk/index.ts';
import { createPerformanceJobs } from './jobs.ts';
import { decodePerformanceCapabilities, invalidResult, isPerformancePage, isPerformanceSessions, isPerformanceStart, requireAfter, requireLimit, requireSession, requireSessionId } from '../domain/results.ts';
import { createPerformanceState } from './state.ts';
import type { PerformanceGateway, PerformanceOptions, PerformanceOutcome, PerformancePage, PerformanceSession, PerformanceSessions, PerformanceStart } from '../domain/types.ts';
export type * from '../domain/types.ts';
export { PerformanceJobFailure, PerformanceWaitFailure } from './jobs.ts';
export { isPerformanceStart } from '../domain/results.ts';

export function createPerformance(gateway: PerformanceGateway, options: PerformanceOptions = {}) {
  const state = createPerformanceState();
  const execute = createPerformanceJobs(gateway, options);
  const lifetime = new AbortController();
  let live = new AbortController();
  let closed = false;
  const queues = new Map<string, Promise<unknown>>();
  const uncertain = new Set<string>();
  function combined(signal: AbortSignal, needsLive = false): AbortSignal {
    if (closed || needsLive && !state.snapshot().liveAvailable) throw new HostError('cancelled', 'unavailable_performance_observation', '性能消费者已关闭或来源观测已撤销');
    return AbortSignal.any([signal, lifetime.signal, ...(needsLive ? [live.signal] : [])]);
  }
  function queued<T>(id: string, run: () => Promise<T>): Promise<T> {
    requireSessionId(id);
    const previous = queues.get(id) ?? Promise.resolve();
    const pending = previous.then(run, run);
    queues.set(id, pending);
    void pending.then(() => { if (queues.get(id) === pending) queues.delete(id); }, () => { if (queues.get(id) === pending) queues.delete(id); });
    return pending;
  }
  async function observe<T>(id: string, signal: AbortSignal, read: (current: AbortSignal) => Promise<PerformanceOutcome<T>>,
    accept: (data: T) => void): Promise<PerformanceOutcome<T>> {
    const current = combined(signal);
    const observation = state.snapshot().selection === id ? state.begin() : null;
    const selected = observation ? AbortSignal.any([current, observation.signal]) : current;
    try {
      const result = await read(selected);
      if (observation) {
        if (!state.current(observation.generation)) throw new HostError('cancelled', 'stale_result', '旧性能会话观测已撤销');
        accept(result.data);
        if (!state.current(observation.generation)) throw new HostError('cancelled', 'stale_result', '旧性能会话观测已撤销');
        state.reconciled(id); state.finish(observation.generation);
      }
      return result;
    } catch (error) { if (observation) state.finish(observation.generation, error); throw error; }
  }
  function inspect(id: string, signal: AbortSignal) {
    return queued(id, async () => {
      const result = await observe(id, signal, (current) => execute('inspect', { session_id: id }, current,
        (value, logId) => requireSession(value, logId, id)), (session) => {
          if (!state.accept(session)) throw new HostError('cancelled', 'stale_result', '较旧的性能会话修订已撤销');
        });
      uncertain.delete(id); return result;
    });
  }
  function control(action: 'pause' | 'resume' | 'stop', id: string, signal: AbortSignal): Promise<PerformanceOutcome<PerformanceSession>> {
    return queued(id, async () => {
      const current = combined(signal, action === 'resume');
      if (action === 'resume' && uncertain.has(id)) throw new HostError('protocol', 'performance_reconcile_required', '恢复前须显式重查会话状态');
      const observation = state.snapshot().selection === id ? state.begin() : null;
      try {
        // 控制请求不绑定视图选择信号：切换视图不会伪装成服务器回滚。
        const result = await execute(action, { session_id: id }, current, (value, logId) => requireSession(value, logId, id));
        if (observation && state.current(observation.generation)) {
          if (!state.accept(result.data)) throw new HostError('cancelled', 'stale_result', '较旧的性能控制结果已撤销');
          state.finish(observation.generation);
        }
        return result;
      } catch (error) {
        uncertain.add(id); state.uncertain(id, error);
        if (observation) state.finish(observation.generation, error);
        throw error;
      }
    });
  }
  return {
    async start(request: PerformanceStart, signal: AbortSignal) {
      if (!isPerformanceStart(request)) throw new HostError('protocol', 'invalid_performance_start', '性能创建参数不符合公开范围');
      const input: JsonValue = { target: { device_id: request.target.device_id, package: request.target.package }, interval_ms: request.interval_ms, duration_secs: request.duration_secs };
      return execute('start', input, combined(signal, true), (value, logId) => {
        const session = requireSession(value, logId);
        if (session.request.target.device_id !== request.target.device_id || session.request.target.package !== request.target.package
          || session.request.interval_ms !== request.interval_ms || session.request.duration_secs !== request.duration_secs) throw invalidResult(logId);
        // 归属以返回 source 为准；旧 start 请求没有客户端代际 CAS。
        return session;
      });
    },
    inspect,
    select(id: string, signal: AbortSignal) { requireSessionId(id); combined(signal); state.select(id); return inspect(id, signal); },
    refresh(signal: AbortSignal) { const id = state.snapshot().selection; if (!id) throw new HostError('protocol', 'no_performance_selection', '尚未选择性能会话'); return inspect(id, signal); },
    pause: (id: string, signal: AbortSignal) => control('pause', id, signal),
    resume: (id: string, signal: AbortSignal) => control('resume', id, signal),
    stop: (id: string, signal: AbortSignal) => control('stop', id, signal),
    samples(id: string, query: { readonly after: number; readonly limit: number }, signal: AbortSignal): Promise<PerformanceOutcome<PerformancePage>> {
      requireAfter(query.after); requireLimit(query.limit);
      return queued(id, () => observe(id, signal, (current) => execute('samples', { session_id: id, after: query.after, limit: query.limit }, current, (value, logId) => {
        if (!isPerformancePage(value) || value.session.id !== id || value.readings.length > query.limit
          || value.next_after < query.after || value.readings.length === 0 && value.next_after !== query.after
          || value.readings.some((reading) => reading.sequence <= query.after)) throw invalidResult(logId);
        return value;
      }), (page) => { if (!state.acceptPage(page, query.after)) throw new HostError('cancelled', 'stale_result', '较旧的性能样本页已撤销'); }));
    },
    list(query: { readonly afterId?: string | null; readonly limit: number }, signal: AbortSignal): Promise<PerformanceOutcome<PerformanceSessions>> {
      const afterId = query.afterId;
      requireLimit(query.limit); if (afterId !== undefined && afterId !== null) requireSessionId(afterId);
      return execute('list', { after_id: afterId ?? null, limit: query.limit }, combined(signal), (value, logId) => {
        if (!isPerformanceSessions(value) || value.sessions.length > query.limit
          || afterId !== undefined && afterId !== null && value.sessions.some((session) => session.id.toLowerCase() <= afterId.toLowerCase())) throw invalidResult(logId);
        return value;
      });
    },
    capabilities: (signal: AbortSignal) => execute('capabilities', {}, combined(signal, true), decodePerformanceCapabilities),
    snapshot: state.snapshot,
    subscribe: state.subscribe,
    invalidateSource() { if (closed) return; live.abort(); live = new AbortController(); state.invalidateLive(); },
    // 只表明调用方已重新取得来源观测，服务器仍执行真实准入。
    refreshSourceObservation() { if (closed) throw new HostError('cancelled', 'cancelled', '性能消费者已关闭'); state.enableLive(); },
    dispose() { if (closed) return; closed = true; lifetime.abort(); live.abort(); state.dispose(); queues.clear(); uncertain.clear(); },
  };
}
export type Performance = ReturnType<typeof createPerformance>;
