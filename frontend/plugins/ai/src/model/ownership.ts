import type { CleanupContext } from '@deviceforge/plugin-sdk';
import { abortable, apiError, ApiError } from '@deviceforge/business-kit/api';
import type { TaskRecord } from '@deviceforge/business-kit/jobs';
import { createAiJobGateway, createAiSessionGateway } from './gateway.ts';
import { isSessionInfo } from './api.ts';
import type { SessionInfo } from './api.ts';

export type AiProvider = 'sdk' | 'cli';
const terminalJob = (job: TaskRecord) =>
  job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
function sameSession(value: SessionInfo, expected: SessionInfo) {
  return value.id === expected.id && value.operation === expected.operation &&
    value.plugin_id === expected.plugin_id && value.generation === expected.generation &&
    value.created_at === expected.created_at;
}
function delay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new ApiError('cancelled', 'ai_cleanup_timeout', 'AI 清理等待已取消')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 100);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** 只有成功提交回执取得归属；恢复和历史目录读取不认领他人资源。 */
export function createAiOwnership(provider: AiProvider) {
  const jobs = new Map<string, TaskRecord>(), streams = new Map<string, SessionInfo>();
  const plugin = provider === 'sdk' ? 'ai-sdk' : 'ai-assistant';
  const operation = `plugin.${plugin}.${provider}.stream`;
  let closed = false;
  function stream(value: unknown, logId: string | null): SessionInfo {
    if (!isSessionInfo(value) || value.operation !== operation || value.plugin_id !== plugin)
      throw new ApiError('protocol', 'invalid_ai_stream_owner', 'AI 会话归属或回执无效', null, logId);
    return value;
  }
  function observeStream(value: unknown, logId: string | null = null) {
    if (closed || !isSessionInfo(value)) return;
    const previous = streams.get(value.id);
    if (!previous) return;
    if (!sameSession(value, previous))
      throw new ApiError('protocol', 'changed_ai_stream_owner', '已归属 AI 会话身份发生变化', null, logId);
    if (value.status === 'finished' && value.completion?.cleanup === 'complete' && value.completion.process_exited)
      streams.delete(value.id);
    else streams.set(value.id, value);
  }
  function observeJob(value: TaskRecord) {
    const previous = jobs.get(value.id);
    if (!previous || closed) return;
    if (previous.operation !== value.operation)
      throw new ApiError('protocol', 'changed_ai_job_owner', '已归属 AI 任务操作发生变化');
    if (terminalJob(value)) jobs.delete(value.id);
    else jobs.set(value.id, value);
  }
  return {
    recordStream(value: unknown, logId: string | null) {
      if (closed) throw new ApiError('cancelled', 'ai_closed', 'AI 实例已进入清理', null, logId);
      const record = stream(value, logId);
      if (record.status !== 'opening' || record.output_sequence !== 0)
        throw new ApiError('protocol', 'invalid_ai_open', 'AI 打开回执不是初始状态', null, logId);
      const previous = streams.get(record.id);
      if (previous && !sameSession(record, previous))
        throw new ApiError('protocol', 'changed_ai_stream_owner', 'AI 打开回执复用了不同代次的已归属会话', null, logId);
      streams.set(record.id, record);
    },
    recordJob(value: TaskRecord, logId: string | null) {
      if (closed) throw new ApiError('cancelled', 'ai_closed', 'AI 实例已进入清理', null, logId);
      if (!value.operation.startsWith(`plugin.${plugin}.`))
        throw new ApiError('protocol', 'invalid_ai_job_owner', 'AI 实例不能认领其他提供者任务', null, logId);
      if (!terminalJob(value)) jobs.set(value.id, value);
    },
    observeJob, observeStream,
    snapshot: () => Object.freeze({ jobs: Object.freeze([...jobs.values()]), streams: Object.freeze([...streams.values()]) }),
    async release(cleanup: CleanupContext) {
      closed = true;
      if (jobs.size === 0 && streams.size === 0) return;
      if (!cleanup.transport)
        throw new ApiError('protocol', 'cleanup_transport_unavailable', '宿主未提供 AI 清理通路');
      const milliseconds = Math.min(5000, cleanup.deadline - Date.now());
      if (milliseconds <= 0) throw new ApiError('cancelled', 'ai_cleanup_timeout', 'AI 清理截止点已到');
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), milliseconds);
      const current = AbortSignal.any([cleanup.signal, deadline.signal]);
      const jobGateway = createAiJobGateway(cleanup.transport), sessionGateway = createAiSessionGateway(cleanup.transport);
      async function bounded<T>(request: Promise<T>) { return abortable(request, current); }
      async function releaseStream(identity: SessionInfo) {
        let logId: string | null = null;
        try {
          let response = await bounded(sessionGateway.get(identity.id, current));
          logId = response.logId;
          let record = stream(response.data, response.logId);
          if (!sameSession(record, identity)) throw new ApiError('protocol', 'changed_ai_stream_owner', '清理前 AI 会话身份不匹配', null, logId);
          if (record.status === 'opening' || record.status === 'running') {
            response = await bounded(sessionGateway.release(identity.id, current));
            logId = response.logId; record = stream(response.data, logId);
            if (!sameSession(record, identity) || (record.status !== 'stopping' && record.status !== 'finished'))
              throw new ApiError('protocol', 'invalid_ai_release', 'AI 释放回执未确认关闭中或已结束', null, logId);
          }
          while (record.status !== 'finished') {
            await delay(current);
            response = await bounded(sessionGateway.get(identity.id, current));
            logId = response.logId; record = stream(response.data, logId);
            if (!sameSession(record, identity)) throw new ApiError('protocol', 'changed_ai_stream_owner', '查询 AI 清理时会话身份改变', null, logId);
          }
          if (record.completion?.cleanup !== 'complete' || !record.completion.process_exited)
            throw new ApiError('protocol', 'ai_cleanup_unconfirmed', 'AI 会话已结束，但直接资源清理尚未确认', null, logId);
          streams.delete(identity.id);
        } catch (error) {
          const failure = apiError(error);
          if (current.aborted) throw new ApiError('cancelled', 'ai_cleanup_timeout', 'AI 会话清理未在截止点内确认', null,
            failure instanceof ApiError ? failure.logId ?? logId : logId);
          throw failure;
        }
      }
      async function releaseJob(identity: TaskRecord) {
        let response = await bounded(jobGateway.getJob(identity.id, current));
        function validate(record: TaskRecord) {
          if (record.id !== identity.id || record.operation !== identity.operation)
            throw new ApiError('protocol', 'changed_ai_job_owner', '清理前 AI 任务归属不匹配', null, response.logId);
        }
        validate(response.data);
        if (!terminalJob(response.data)) {
          response = await bounded(jobGateway.cancelJob(identity.id, current)); validate(response.data);
        }
        while (!terminalJob(response.data)) {
          await delay(current);
          response = await bounded(jobGateway.getJob(identity.id, current)); validate(response.data);
        }
        jobs.delete(identity.id);
      }
      try {
        const results = await Promise.allSettled([
          ...[...streams.values()].map(releaseStream), ...[...jobs.values()].map(releaseJob),
        ]);
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, '部分 AI 自有资源撤销未确认');
      } finally { clearTimeout(timer); }
    },
  };
}
