export class JobFailure extends Error {
    job;
    submitLogId;
    logId;
    constructor(job, submitLogId, logId) {
        super(job.error ?? (job.status === 'cancelled' ? '操作任务已取消' : '操作任务失败'));
        this.name = 'JobFailure';
        this.job = job;
        this.submitLogId = submitLogId;
        this.logId = logId;
    }
}
export class JobWaitFailure extends Error {
    job;
    submitLogId;
    logId;
    lastKnownLogId;
    constructor(job, submitLogId, logId, cause, lastKnownLogId = logId) {
        super(cause instanceof Error ? cause.message : '任务等待失败，需重新查询真实状态', { cause });
        this.name = 'JobWaitFailure';
        this.job = job;
        this.submitLogId = submitLogId;
        this.logId = logId;
        this.lastKnownLogId = lastKnownLogId;
    }
}
