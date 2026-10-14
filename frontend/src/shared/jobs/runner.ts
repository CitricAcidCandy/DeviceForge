import { abortable } from '../../services/api/abort.ts';
import { ApiError } from '../../services/api/errors.ts';
import type { ApiResult } from '../../services/api/index.ts';
import { JobFailure, JobWaitFailure } from './errors.ts';
import type { JobGateway, JobOptions, JobOutcome, JobTicket, TaskRecord } from './types.ts';
import type { JsonData } from './values.ts';

function assertActive(signal: AbortSignal, logId: string | null = null): void {
  if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '任务等待已取消', null, logId);
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new ApiError('cancelled', 'cancelled', '任务等待已取消')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
function validate(result: ApiResult<TaskRecord>, ticket: JobTicket): void {
  const job = result.data;
  if (!job.id || job.id !== ticket.id || job.operation !== ticket.operation
    || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status)
    || job.error != null && typeof job.error !== 'string') {
    throw new ApiError('protocol', 'invalid_job', '任务身份、操作或状态不兼容', null, result.logId);
  }
}
export function createJobRunner(gateway: JobGateway, options: JobOptions = {}) {
  const interval = options.pollIntervalMs ?? 100;
  if (!Number.isFinite(interval) || interval < 0 || interval > 60000) throw new Error('任务轮询间隔须为 0–60000 毫秒');
  const lifetime = new AbortController();
  const combined = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  async function finish<T>(initial: ApiResult<TaskRecord>, ticket: JobTicket, signal: AbortSignal,
    decode: (value: unknown, logId: string | null) => T): Promise<JobOutcome<T>> {
    let current = initial;
    try {
      while (true) {
        assertActive(signal, current.logId); validate(current, ticket);
        const job = current.data;
        if (job.status === 'succeeded') {
          const data = decode(job.result, current.logId);
          assertActive(signal, current.logId);
          return { data, job, submitLogId: ticket.submitLogId, logId: current.logId };
        }
        if (job.status === 'failed' || job.status === 'cancelled') throw new JobFailure(job, ticket.submitLogId, current.logId);
        await pause(interval, signal);
        current = await abortable(gateway.getJob(ticket.id, signal), signal);
      }
    } catch (error) {
      if (error instanceof JobFailure || error instanceof ApiError && error.kind === 'protocol') throw error;
      // 取消客户端等待不代表服务器取消，也不自动重新提交。
      throw new JobWaitFailure(current.data, ticket.submitLogId, error instanceof ApiError ? error.logId : null, error, current.logId);
    }
  }
  async function query(ticket: JobTicket, signal: AbortSignal): Promise<ApiResult<TaskRecord>> {
    const current = combined(signal); assertActive(current);
    if (!ticket.id || !ticket.operation) throw new ApiError('protocol', 'invalid_job_ticket', '查询任务需要有效身份和操作');
    const result = await abortable(gateway.getJob(ticket.id, current), current);
    assertActive(current, result.logId); validate(result, ticket); return result;
  }
  return {
    async execute<T>(operation: string, input: JsonData, signal: AbortSignal, decode: (value: unknown, logId: string | null) => T): Promise<JobOutcome<T>> {
      const current = combined(signal); assertActive(current);
      const submitted = await abortable(gateway.submit(operation, input, current), current);
      const ticket = { id: submitted.data.id, operation, submitLogId: submitted.logId };
      return finish(submitted, ticket, current, decode);
    },
    async resume<T>(ticket: JobTicket, signal: AbortSignal, decode: (value: unknown, logId: string | null) => T): Promise<JobOutcome<T>> {
      const current = combined(signal); return finish(await query(ticket, current), ticket, current, decode);
    },
    query,
    async cancel(ticket: JobTicket, signal: AbortSignal): Promise<ApiResult<TaskRecord>> {
      const current = combined(signal); assertActive(current);
      if (!ticket.id || !ticket.operation) throw new ApiError('protocol', 'invalid_job_ticket', '取消任务需要有效身份和操作');
      const result = await abortable(gateway.cancelJob(ticket.id, current), current);
      assertActive(current, result.logId); validate(result, ticket); return result;
    },
    dispose() { lifetime.abort(); },
  };
}
