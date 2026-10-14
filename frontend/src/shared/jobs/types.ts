import type { ApiResult, JobDto } from '../../services/api/index.ts';
import type { JsonData } from './values.ts';

// 任务字段直接索引生成契约；公开 SDK 的精简任务也能结构化消费。
export type TaskRecord = Pick<JobDto, 'id' | 'operation' | 'status' | 'result' | 'error'>;
export interface JobGateway {
  readonly submit: (
    operation: string,
    input: JsonData,
    signal: AbortSignal,
  ) => Promise<ApiResult<TaskRecord>>;
  readonly getJob: (id: string, signal: AbortSignal) => Promise<ApiResult<TaskRecord>>;
  readonly cancelJob: (id: string, signal: AbortSignal) => Promise<ApiResult<TaskRecord>>;
}
export interface JobOptions {
  readonly pollIntervalMs?: number;
}
export interface JobOutcome<T> {
  readonly data: T;
  readonly job: TaskRecord;
  readonly submitLogId: string | null;
  readonly logId: string | null;
}
export interface JobTicket {
  readonly id: string;
  readonly operation: string;
  readonly submitLogId: string | null;
}
