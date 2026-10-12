import type { TaskRecord } from './types.ts';

export class JobFailure extends Error {
  readonly job: TaskRecord;
  readonly submitLogId: string | null;
  readonly logId: string | null;
  constructor(job: TaskRecord, submitLogId: string | null, logId: string | null) {
    super(job.error ?? (job.status === 'cancelled' ? '操作任务已取消' : '操作任务失败'));
    this.name = 'JobFailure'; this.job = job; this.submitLogId = submitLogId; this.logId = logId;
  }
}
export class JobWaitFailure extends Error {
  readonly job: TaskRecord;
  readonly submitLogId: string | null;
  readonly logId: string | null;
  readonly lastKnownLogId: string | null;
  constructor(job: TaskRecord, submitLogId: string | null, logId: string | null, cause: unknown, lastKnownLogId: string | null = logId) {
    super(cause instanceof Error ? cause.message : '任务等待失败，需重新查询真实状态', { cause });
    this.name = 'JobWaitFailure'; this.job = job; this.submitLogId = submitLogId; this.logId = logId; this.lastKnownLogId = lastKnownLogId;
  }
}
