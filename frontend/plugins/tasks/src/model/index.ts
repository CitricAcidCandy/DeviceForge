import { HostError } from '@deviceforge/plugin-sdk';
import type { HistoricalJob, HostContext, HostResult } from '@deviceforge/plugin-sdk';
import { decodeEvents, decodeLogs, identifier, invalid } from './rules.ts';
import type { LogOrder, TaskEvent, TaskLookup, TaskSelection } from './types.ts';
export type * from './types.ts';
export { formatJobProgress } from './rules.ts';
export { decodePublication, downloadTaskArtifact } from './publication.ts';

function isMissing(error: unknown): boolean {
  return error instanceof HostError && error.status === 404;
}
function active(signal: AbortSignal): void {
  if (signal.aborted) throw new HostError('cancelled', 'task_wait_cancelled', '任务读取等待已结束');
}
/** 构造只建立本地状态；列表、查询、取消均由界面显式发起。 */
export function createTasksModel(context: HostContext) {
  const lifetime = new AbortController();
  const listeners = new Set<(selection: TaskSelection) => void>();
  let selected: TaskSelection = Object.freeze({ result: null, cancellation: null });
  let selectionRevision = 0;
  let cancellationRevision = 0;
  const scoped = (caller: AbortSignal, timeout = 5_000) => {
    const signal = AbortSignal.any([caller, context.signal, lifetime.signal, AbortSignal.timeout(timeout)]);
    active(signal);
    return signal;
  };
  const history = () => {
    if (!context.taskHistory) throw new HostError('protocol', 'task_history_unavailable', '宿主未提供任务历史接口');
    return context.taskHistory;
  };
  const publish = (next: TaskSelection) => {
    if (lifetime.signal.aborted || context.signal.aborted) return;
    selected = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(selected); } catch { /* 单个视图不能阻断其他订阅。 */ }
    }
  };
  const get = async (id: string, signal: AbortSignal): Promise<HostResult<HistoricalJob>> => {
    const response = await history().get(id, signal);
    active(signal);
    if (response.data.id.toLowerCase() !== id.toLowerCase()) invalid('服务返回的任务编号不一致', response.logId);
    return response;
  };
  const model = {
    snapshot: () => selected,
    subscribe(listener: (selection: TaskSelection) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async list(query: { limit?: number }, caller: AbortSignal) {
      if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200))
        throw new HostError('protocol', 'invalid_task_limit', '任务列表数量必须为 1 至 200');
      const signal = scoped(caller);
      const response = await history().list(query, signal);
      active(signal);
      return response;
    },
    async select(id: string, caller: AbortSignal) {
      const revision = ++selectionRevision;
      const signal = scoped(caller);
      const response = await get(id, signal);
      if (revision !== selectionRevision) throw new HostError('cancelled', 'stale_selection', '旧任务选择已撤销', response.logId);
      const cancellation = selected.cancellation;
      const terminal = response.data.status === 'cancelled' ? 'cancelled' :
        response.data.status === 'succeeded' || response.data.status === 'failed' ? 'finished' : null;
      publish({
        result: response,
        cancellation: cancellation?.id === id && terminal
          ? Object.freeze({ ...cancellation, state: terminal }) : cancellation,
      });
      return response;
    },
    async events(id: string, _query: Record<string, never>, caller: AbortSignal): Promise<HostResult<readonly TaskEvent[]>> {
      const signal = scoped(caller);
      if (!context.transport) {
        const response = await history().events(id, {}, signal);
        active(signal);
        return response;
      }
      const response = await context.transport.request({
        path: `/api/v2/jobs/${encodeURIComponent(id)}/events`, method: 'GET',
      }, signal);
      active(signal);
      return { data: decodeEvents(response.data, id, response.logId), logId: response.logId };
    },
    async search(query: string, order: LogOrder, caller: AbortSignal): Promise<HostResult<TaskLookup>> {
      const text = query.trim();
      if (!text || new TextEncoder().encode(text).length > 128 || /\p{Cc}/u.test(text))
        throw new HostError('protocol', 'invalid_input', '请填写 1 至 128 字节的搜索词或完整编号');
      const signal = scoped(caller);
      const byId = identifier(text);
      if (byId) {
        try {
          const response = await get(text, signal);
          return { data: { query: text, jobs: [response.data], logs: null, missingJobIds: [] }, logId: response.logId };
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      if (!context.transport) throw new HostError('protocol', 'log_search_unavailable', '宿主未提供公开日志查询通信');
      const parameters = new URLSearchParams({ [byId ? 'log_id' : 'q']: text, order });
      const response = await context.transport.request({
        path: `/api/v2/diagnostics/logs?${parameters}`, method: 'GET',
      }, signal);
      active(signal);
      const logs = decodeLogs(response.data, response.logId);
      if (byId ? logs.log_id?.toLowerCase() !== text.toLowerCase() : logs.log_id !== null)
        invalid('服务返回的日志编号与查询不一致', response.logId);
      const jobs: HistoricalJob[] = [];
      const missingJobIds: string[] = [];
      for (let offset = 0; offset < logs.job_ids.length; offset += 4) {
        const batch = await Promise.all(logs.job_ids.slice(offset, offset + 4).map(async (id) => {
          try { return (await get(id, signal)).data; }
          catch (error) { if (isMissing(error)) { missingJobIds.push(id); return null; } throw error; }
        }));
        jobs.push(...batch.filter((job): job is HistoricalJob => job !== null));
      }
      active(signal);
      return { data: { query: text, jobs, logs, missingJobIds }, logId: response.logId };
    },
    async cancel(id: string, caller: AbortSignal) {
      const revision = ++cancellationRevision;
      const signal = scoped(caller, 10_000);
      publish({ ...selected, cancellation: Object.freeze({ id, state: 'requested', logId: null }) });
      try {
        const response = await context.cancelJob(id, signal);
        active(signal);
        if (response.data.id !== id) invalid('取消回执的任务归属不一致', response.logId);
        const state = response.data.status === 'cancelled' ? 'cancelled' :
          response.data.status === 'succeeded' || response.data.status === 'failed' ? 'finished' : 'requested';
        if (revision === cancellationRevision)
          publish({ ...selected, cancellation: Object.freeze({ id, state, logId: response.logId }) });
        return response;
      } catch (error) {
        if (revision === cancellationRevision) publish({
          ...selected,
          cancellation: Object.freeze({ id, state: 'unknown', logId: error instanceof HostError ? error.logId : null }),
        });
        throw error;
      }
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      context.signal.removeEventListener('abort', model.dispose);
      selectionRevision++;
      cancellationRevision++;
      listeners.clear();
    },
  };
  context.signal.addEventListener('abort', model.dispose, { once: true });
  if (context.signal.aborted) model.dispose();
  return model;
}
export type TasksModel = ReturnType<typeof createTasksModel>;
