import { HostError } from '../../../plugin-sdk/index.ts';
import type { HostResult, Job, JsonValue } from '../../../plugin-sdk/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import { performanceOperation } from '../utils/results.ts';
import type { PerformanceAction, PerformanceGateway, PerformanceOptions, PerformanceOutcome } from '../types/index.ts';

export class PerformanceJobFailure extends Error {
  readonly job: Job;
  readonly submitLogId: string | null;
  readonly logId: string | null;
  constructor(job: Job, submitLogId: string | null, logId: string | null) {
    super(job.error ?? (job.status === 'cancelled' ? '性能操作任务已取消' : '性能操作任务失败'));
    this.name = 'PerformanceJobFailure';
    this.job = job;
    this.submitLogId = submitLogId;
    this.logId = logId;
  }
}
export class PerformanceWaitFailure extends Error {
  readonly job: Job;
  readonly submitLogId: string | null;
  readonly logId: string | null;
  constructor(job: Job, submitLogId: string | null, logId: string | null, cause: unknown) {
    super(cause instanceof Error ? cause.message : '性能任务等待失败，需重新查询真实状态', { cause });
    this.name = 'PerformanceWaitFailure';
    this.job = job;
    this.submitLogId = submitLogId;
    this.logId = logId;
  }
}
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); reject(new HostError('cancelled', 'cancelled', '性能任务等待已取消')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve(); }, milliseconds);
    if (signal.aborted) cancelled(); else signal.addEventListener('abort', cancelled, { once: true });
  });
}
export function createPerformanceJobs(gateway: PerformanceGateway, options: PerformanceOptions) {
  const interval = options.pollIntervalMs ?? 100;
  if (!Number.isFinite(interval) || interval < 0 || interval > 60000) throw new Error('任务轮询间隔必须为 0–60000 毫秒');
  return async function execute<T>(action: PerformanceAction, input: JsonValue, signal: AbortSignal,
    decode: (value: unknown, logId: string | null) => T): Promise<PerformanceOutcome<T>> {
    if (signal.aborted) throw new HostError('cancelled', 'cancelled', '性能请求等待已取消');
    const operation = performanceOperation(action);
    const submitted = await abortable(gateway.submit(operation, input, signal), signal);
    let current: HostResult<Job> = submitted;
    const jobId = submitted.data.id;
    try {
      while (true) {
        if (signal.aborted) throw new HostError('cancelled', 'cancelled', '性能请求等待已取消');
        const job = current.data;
        if (!jobId || job.id !== jobId || job.operation !== operation) throw new HostError('protocol', 'invalid_performance_job', '性能任务身份或操作不匹配', current.logId);
        if (job.status === 'succeeded') return { data: decode(job.result, current.logId), job, submitLogId: submitted.logId, logId: current.logId };
        if (job.status === 'failed' || job.status === 'cancelled') throw new PerformanceJobFailure(job, submitted.logId, current.logId);
        if (job.status !== 'queued' && job.status !== 'running') throw new HostError('protocol', 'invalid_performance_job', '性能任务状态不兼容', current.logId);
        await wait(interval, signal);
        current = await abortable(gateway.getJob(jobId, signal), signal);
      }
    } catch (error) {
      if (error instanceof PerformanceJobFailure || error instanceof HostError && error.kind === 'protocol') throw error;
      // 保留已提交的任务及真实错误，不把查询日志当作执行日志。
      throw new PerformanceWaitFailure(current.data, submitted.logId, current.logId, error);
    }
  };
}
