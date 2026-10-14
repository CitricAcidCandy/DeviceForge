import { HostError } from '../plugin-sdk/index.ts';
import type {
  HistoricalJob,
  HostResult,
  Job,
  JobEvent,
  TaskEventQuery,
  TaskHistoryAccess,
  TaskHistoryQuery,
} from '../plugin-sdk/index.ts';
import { isJsonValue } from '../plugin-sdk/json.ts';
import type {
  ApiResult,
  EventQuery,
  JobDto,
  JobEventDto,
  JobQuery,
} from '../services/api/index.ts';
import { abortable } from '../services/api/abort.ts';
import { publicCall, publicJob } from './public-api.ts';

// 注入现有任务端口；生成类型只在宿主适配层使用，不复制 HTTP 或持久化业务。
export interface TaskHistoryTransport {
  readonly list: (query: JobQuery, signal: AbortSignal) => Promise<ApiResult<JobDto[]>>;
  readonly get: (id: string, signal: AbortSignal) => Promise<ApiResult<JobDto>>;
  readonly events: (
    id: string,
    query: EventQuery,
    signal: AbortSignal,
  ) => Promise<ApiResult<JobEventDto[]>>;
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value !== '.' && value !== '..';
}
function status(value: unknown): value is Job['status'] {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}
function arrayShape(value: unknown): boolean {
  return Array.isArray(value);
}
function invalidQuery(): never {
  throw new HostError('protocol', 'invalid_history_query', '任务历史查询参数不符合公开契约');
}
function queryId(id: string): string {
  if (!identifier(id)) invalidQuery();
  return id;
}
function historyQuery(query: TaskHistoryQuery): JobQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query)) invalidQuery();
  const limit = query.limit;
  if (limit !== undefined && (!nonNegativeInteger(limit) || limit < 1 || limit > 200))
    invalidQuery();
  return Object.freeze(limit === undefined ? {} : { limit });
}
function eventQuery(query: TaskEventQuery): EventQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query)) invalidQuery();
  const after = query.after;
  if (after !== undefined && !nonNegativeInteger(after)) invalidQuery();
  return Object.freeze(after === undefined ? {} : { after });
}
export function publicHistoricalJob(dto: JobDto, expectedId?: string): HistoricalJob {
  if (
    !dto ||
    !identifier(dto.id) ||
    (expectedId !== undefined && dto.id !== expectedId) ||
    typeof dto.operation !== 'string' ||
    !status(dto.status) ||
    !nonNegativeInteger(dto.created_at) ||
    !isJsonValue(dto.input) ||
    !isJsonValue(dto.result ?? null) ||
    (dto.error !== undefined && dto.error !== null && typeof dto.error !== 'string')
  ) {
    throw new HostError('protocol', 'invalid_history', '任务历史响应不符合公开契约');
  }
  return Object.freeze({ ...publicJob(dto), input: dto.input, createdAt: dto.created_at });
}
export function publicHistoricalJobs(rows: readonly JobDto[]): readonly HistoricalJob[] {
  if (!arrayShape(rows)) throw new HostError('protocol', 'invalid_history', '任务历史列表不是数组');
  return Object.freeze(rows.map((row) => publicHistoricalJob(row)));
}
export function publicJobEvents(
  rows: readonly JobEventDto[],
  id: string,
  after: number,
): readonly JobEvent[] {
  if (!arrayShape(rows) || !identifier(id) || !nonNegativeInteger(after)) {
    throw new HostError('protocol', 'invalid_job_events', '任务事件列表或关联参数不符合公开契约');
  }
  let previous = after;
  const result = rows.map((row): JobEvent => {
    if (
      !row ||
      !identifier(row.job_id) ||
      row.job_id !== id ||
      !nonNegativeInteger(row.sequence) ||
      row.sequence < 1 ||
      row.sequence <= previous ||
      !nonNegativeInteger(row.timestamp) ||
      !status(row.status)
    ) {
      throw new HostError(
        'protocol',
        'invalid_job_events',
        '任务事件序号、关联或内容不符合公开契约',
      );
    }
    previous = row.sequence;
    return Object.freeze({
      sequence: row.sequence,
      jobId: row.job_id,
      status: row.status,
      timestamp: row.timestamp,
    });
  });
  return Object.freeze(result);
}
async function queryCall<T, U>(
  request: () => Promise<ApiResult<T>>,
  signal: AbortSignal,
  map: (data: T) => U,
): Promise<HostResult<U>> {
  // 复用传输层取消等待，即使注入端口同步抛错、忽略信号或永不返回也安全收口。
  const pending = Promise.resolve().then(() => {
    if (signal.aborted) throw new HostError('cancelled', 'cancelled', '任务历史等待已取消');
    return request();
  });
  const result = await publicCall(abortable(pending, signal), map);
  if (signal.aborted)
    throw new HostError('cancelled', 'stale_result', '任务历史晚到结果已撤销', result.logId);
  return Object.freeze(result);
}
export function createTaskHistoryGateway(
  transport: TaskHistoryTransport,
  lifetime: AbortSignal,
): TaskHistoryAccess {
  function active(caller: AbortSignal): AbortSignal {
    if (lifetime.aborted) throw new HostError('cancelled', 'host_closed', '任务历史宿主已关闭');
    const signal = AbortSignal.any([caller, lifetime]);
    if (signal.aborted) throw new HostError('cancelled', 'cancelled', '任务历史等待已取消');
    return signal;
  }
  return Object.freeze<TaskHistoryAccess>({
    async list(query, caller) {
      const signal = active(caller);
      const parameters = historyQuery(query);
      return queryCall(() => transport.list(parameters, signal), signal, publicHistoricalJobs);
    },
    async get(id, caller) {
      const signal = active(caller);
      const target = queryId(id);
      return queryCall(
        () => transport.get(target, signal),
        signal,
        (data) => publicHistoricalJob(data, target),
      );
    },
    async events(id, query, caller) {
      const signal = active(caller);
      const target = queryId(id);
      const parameters = eventQuery(query);
      const after = parameters.after ?? 0;
      return queryCall(
        () => transport.events(target, parameters, signal),
        signal,
        (data) => publicJobEvents(data, target, after),
      );
    },
  });
}
