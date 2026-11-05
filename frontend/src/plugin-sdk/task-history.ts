import type { Dispose, HostResult, Job, JsonValue } from './models.ts';

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
/** 仅通知历史快照可能变化；不携带连接、凭据或任务正文。 */
export interface TaskHistoryChange {
  readonly state: 'ready' | 'changed' | 'unavailable';
  readonly revision: string | null;
  readonly reset: boolean;
}
export interface TaskHistoryAccess {
  readonly subscribeChanges?: (listener: (change: TaskHistoryChange) => void) => Dispose;
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
