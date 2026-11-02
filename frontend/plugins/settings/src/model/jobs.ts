import { HostError } from '@deviceforge/plugin-sdk';
import type { HostResult, Job, JsonValue } from '@deviceforge/plugin-sdk';
import type { SettingsGateway, SettingsJobOptions, SettingsOutcome, SettingsTicket } from './types.ts';

export class SettingsJobFailure extends Error {
  readonly job: Job;
  readonly submitLogId: string | null;
  readonly logId: string | null;
  constructor(
    job: Job, submitLogId: string | null, logId: string | null,
  ) {
    super(job.error ?? (job.status === 'cancelled' ? '配置任务已取消' : '配置任务失败'));
    this.name = 'SettingsJobFailure';
    this.job = job; this.submitLogId = submitLogId; this.logId = logId;
  }
}
export class SettingsWaitFailure extends Error {
  readonly job: Job;
  readonly submitLogId: string | null;
  readonly logId: string | null;
  readonly lastKnownLogId: string | null;
  constructor(
    job: Job, submitLogId: string | null, logId: string | null,
    cause: unknown, lastKnownLogId: string | null,
  ) {
    super(cause instanceof Error ? cause.message : '配置任务结果未确认，请查询原任务', { cause });
    this.name = 'SettingsWaitFailure';
    this.job = job; this.submitLogId = submitLogId; this.logId = logId; this.lastKnownLogId = lastKnownLogId;
  }
}
function cancelled(logId: string | null = null): HostError {
  return new HostError('cancelled', 'cancelled', '配置任务等待已取消，未确认后台任务已取消', logId);
}
function active(signal: AbortSignal, logId: string | null = null): void {
  if (signal.aborted) throw cancelled(logId);
}
function pending<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { release(); reject(cancelled()); };
    const release = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) {
      void request.catch(() => undefined);
      reject(cancelled());
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    request.then((value) => { release(); if (!signal.aborted) resolve(value); },
      (error: unknown) => { release(); if (!signal.aborted) reject(error); });
  });
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
function validate(result: HostResult<Job>, ticket: SettingsTicket): void {
  if (!result.data.id || result.data.id !== ticket.id || result.data.operation !== ticket.operation ||
      !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(result.data.status) ||
      (result.data.error !== null && typeof result.data.error !== 'string'))
    throw new HostError('protocol', 'invalid_settings_job', '配置任务身份、操作或状态不兼容', result.logId);
}
/** 仅复用公开 Job；恢复与取消都针对原任务，不重新提交配置写入。 */
export function createJobRunner(gateway: SettingsGateway, options: SettingsJobOptions = {}) {
  const interval = options.pollIntervalMs ?? 100;
  if (!Number.isFinite(interval) || interval < 0 || interval > 60000) throw new Error('任务轮询间隔须为 0–60000 毫秒');
  const lifetime = new AbortController();
  const combined = (signal: AbortSignal) => AbortSignal.any([
    signal, lifetime.signal, ...(options.signal ? [options.signal] : []),
  ]);
  async function finish<T>(
    initial: HostResult<Job>, ticket: SettingsTicket, signal: AbortSignal,
    decode: (value: unknown, logId: string | null) => T,
  ): Promise<SettingsOutcome<T>> {
    let current = initial;
    try {
      while (true) {
        active(signal, current.logId);
        validate(current, ticket);
        const job = current.data;
        if (job.status === 'succeeded') {
          const data = decode(job.result, current.logId);
          active(signal, current.logId);
          return { data, job, submitLogId: ticket.submitLogId, logId: current.logId };
        }
        if (job.status === 'failed' || job.status === 'cancelled')
          throw new SettingsJobFailure(job, ticket.submitLogId, current.logId);
        await pause(interval, signal);
        current = await pending(gateway.getJob(ticket.id, signal), signal);
      }
    } catch (error) {
      if (error instanceof SettingsJobFailure || (error instanceof HostError && error.kind === 'protocol')) throw error;
      throw new SettingsWaitFailure(current.data, ticket.submitLogId,
        error instanceof HostError ? error.logId : null, error, current.logId);
    }
  }
  async function query(ticket: SettingsTicket, signal: AbortSignal): Promise<HostResult<Job>> {
    const current = combined(signal);
    active(current);
    if (!ticket.id || !ticket.operation) throw new HostError('protocol', 'invalid_settings_ticket', '查询配置任务需要有效身份和操作');
    const result = await pending(gateway.getJob(ticket.id, current), current);
    active(current, result.logId);
    validate(result, ticket);
    return result;
  }
  return {
    async execute<T>(
      operation: string, input: JsonValue, signal: AbortSignal,
      decode: (value: unknown, logId: string | null) => T,
    ): Promise<SettingsOutcome<T>> {
      const current = combined(signal);
      active(current);
      const submitted = await pending(gateway.submit(operation, input, current), current);
      return finish(submitted, { id: submitted.data.id, operation, submitLogId: submitted.logId }, current, decode);
    },
    async resume<T>(
      ticket: SettingsTicket, signal: AbortSignal, decode: (value: unknown, logId: string | null) => T,
    ): Promise<SettingsOutcome<T>> {
      const current = combined(signal);
      return finish(await query(ticket, current), ticket, current, decode);
    },
    query,
    async cancel(ticket: SettingsTicket, signal: AbortSignal): Promise<HostResult<Job>> {
      const current = combined(signal);
      active(current);
      if (!ticket.id || !ticket.operation) throw new HostError('protocol', 'invalid_settings_ticket', '取消配置任务需要有效身份和操作');
      const result = await pending(gateway.cancelJob(ticket.id, current), current);
      active(current, result.logId);
      validate(result, ticket);
      return result;
    },
    dispose() { lifetime.abort(); },
  };
}
