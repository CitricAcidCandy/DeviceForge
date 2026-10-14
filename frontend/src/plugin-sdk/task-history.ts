import type { HostResult, Job, JsonValue } from './models.ts';

// 只公开持久化任务记录，不从当前操作或设备目录补写元数据。
export interface HistoricalJob extends Job {
  readonly input: JsonValue;
  readonly createdAt: number;
}
export interface JobEvent {
  readonly sequence: number;
  readonly jobId: string;
  readonly status: Job['status'];
  readonly timestamp: number;
}
export interface TaskHistoryQuery {
  readonly limit?: number;
}
export interface TaskEventQuery {
  readonly after?: number;
}
export interface TaskHistoryAccess {
  readonly list: (
    query: TaskHistoryQuery,
    signal: AbortSignal,
  ) => Promise<HostResult<readonly HistoricalJob[]>>;
  readonly get: (id: string, signal: AbortSignal) => Promise<HostResult<HistoricalJob>>;
  readonly events: (
    id: string,
    query: TaskEventQuery,
    signal: AbortSignal,
  ) => Promise<HostResult<readonly JobEvent[]>>;
}
