import { HostError, JobFailure, JobWaitFailure, readHostError } from '@deviceforge/plugin-sdk';
import type {
  HostContext, HostResult, Job, ServiceDirectoryEntry, ServiceRef,
} from '@deviceforge/plugin-sdk';
import { message } from '../domain/message.ts';
import type { MessageValue } from '../domain/message.ts';
import { normalizeContract, submitNormalize } from '../../shared/service-contracts.ts';

export const NORMALIZE_SERVICE: ServiceRef = normalizeContract.ref;
function active(signal: AbortSignal) {
  if (signal.aborted)
    throw new HostError('cancelled', 'example_normalize_wait_cancelled',
      '仅停止本地等待，服务器任务状态需按原票据查询');
}
function waiting<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      signal.removeEventListener('abort', cancelled);
      reject(new HostError('cancelled', 'example_normalize_wait_cancelled',
        '仅停止本地等待，服务器任务状态需按原票据查询'));
    };
    signal.addEventListener('abort', cancelled, { once: true });
    request.then((value) => { signal.removeEventListener('abort', cancelled); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', cancelled); reject(error); });
    if (signal.aborted) cancelled();
  });
}
async function pause(signal: AbortSignal) {
  active(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new HostError('cancelled', 'example_normalize_wait_cancelled', '等待已结束，请查询原任务'));
    };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 25);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function provider(entries: readonly ServiceDirectoryEntry[]): ServiceDirectoryEntry & { operation: string } {
  const found = entries.filter((entry) => entry.service.id === NORMALIZE_SERVICE.id &&
    entry.service.version === NORMALIZE_SERVICE.version && entry.available);
  const selected = found.length === 1 ? found[0] : null;
  if (!selected?.operation)
    throw new HostError('protocol', 'example_normalize_unavailable',
      '规范化服务缺失或存在歧义，请核对配套服务器组件与精确版本');
  return { ...selected, operation: selected.operation };
}
function validateJob(result: HostResult<Job>, expectedOperation: string, expectedId?: string) {
  const job = result.data;
  if (!job.id || job.operation !== expectedOperation || (expectedId && job.id !== expectedId) ||
      !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status))
    throw new HostError('protocol', 'example_normalize_job_mismatch',
      '返回任务与原服务操作不一致', result.logId);
}

/** 只提交一次；查询和所有本地等待共用十秒上限，绝不把取消当成后台取消。 */
export async function normalizeRemote(context: HostContext, input: unknown,
  caller: AbortSignal): Promise<HostResult<MessageValue>> {
  const server = context.services?.server;
  if (!server) throw new HostError('protocol', 'example_server_services_missing', '宿主没有公开服务器服务入口');
  const value = message(input), budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), 10_000);
  const signal = AbortSignal.any([caller, context.signal, budget.signal]);
  let last: HostResult<Job> | null = null, submitLogId: string | null = null;
  try {
    active(signal);
    const entry = provider((await waiting(server.list(signal), signal)).data);
    active(signal);
    const submitted = await waiting(submitNormalize(server, { ...value }, signal,
      entry.provider.generation), signal);
    submitLogId = submitted.logId;
    last = submitted;
    validateJob(submitted, entry.operation);
    let current: HostResult<Job> = submitted;
    while (current.data.status === 'queued' || current.data.status === 'running') {
      await pause(signal);
      const next: HostResult<Job> = await waiting(context.getJob(current.data.id, signal), signal);
      active(signal);
      validateJob(next, current.data.operation, current.data.id);
      current = next;
      last = current;
    }
    if (current.data.status !== 'succeeded') throw new JobFailure(current.data, submitLogId, current.logId);
    const latestProvider = provider((await waiting(server.list(signal), signal)).data);
    active(signal);
    if (latestProvider.provider.generation !== entry.provider.generation || latestProvider.provider.id !== entry.provider.id ||
        latestProvider.operation !== entry.operation)
      throw new HostError('cancelled', 'example_normalize_provider_changed',
        '规范化提供者已换代，旧结果未交付，请查询原任务', current.logId);
    // 公开服务的 Job 直接保存声明输出，不能按普通操作的产物封套再拆一层。
    return { data: message(current.data.result), logId: current.logId };
  } catch (error) {
    if (!last || error instanceof JobFailure) throw error;
    throw new JobWaitFailure(last.data, submitLogId, readHostError(error)?.logId ?? null, error, last.logId);
  } finally { clearTimeout(timer); }
}
