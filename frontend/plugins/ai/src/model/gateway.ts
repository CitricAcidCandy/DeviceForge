import type { PluginJsonRequest, PluginTransport, Operation } from '@deviceforge/plugin-sdk';
import { apiError, ApiError, isRecord } from '@deviceforge/business-kit/api';
import { isJsonData, naturalNumber, requireJson } from '@deviceforge/business-kit/jobs';
import type { JobGateway, TaskRecord } from '@deviceforge/business-kit/jobs';
import { sessionPath } from './api.ts';
import type { SessionGateway } from './api.ts';

export type AiRequest = Pick<PluginTransport, 'request'>;
export function aiRequest(transport: AiRequest) {
  return async (input: PluginJsonRequest, signal: AbortSignal) => {
    try { return await transport.request(input, signal); }
    catch (error) { throw apiError(error); }
  };
}

export function decodeTask(value: unknown, logId: string | null): TaskRecord {
  const result = isRecord(value) ? value.result ?? null : null;
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id ||
      typeof value.operation !== 'string' || !value.operation ||
      (value.status !== 'queued' && value.status !== 'running' && value.status !== 'succeeded' &&
       value.status !== 'failed' && value.status !== 'cancelled') ||
      (value.error !== undefined && value.error !== null && typeof value.error !== 'string') ||
      !isJsonData(result))
    throw new ApiError('protocol', 'invalid_ai_job', 'AI 任务回执与公开契约不符', null, logId);
  return { id: value.id, operation: value.operation, status: value.status,
    result, error: typeof value.error === 'string' ? value.error : null };
}
export function createAiJobGateway(transport: AiRequest): JobGateway {
  const request = aiRequest(transport);
  async function job(input: PluginJsonRequest, signal: AbortSignal) {
    const result = await request(input, signal);
    return { data: decodeTask(result.data, result.logId), logId: result.logId };
  }
  const path = (id: string) => `/api/v2/jobs/${encodeURIComponent(id)}`;
  return {
    submit: (operation, input, signal) => job({
      path: '/api/v2/jobs', method: 'POST', body: { operation, input },
    }, signal),
    getJob: (id, signal) => job({ path: path(id) }, signal),
    cancelJob: (id, signal) => job({ path: `${path(id)}/cancel`, method: 'POST' }, signal),
  };
}
export function createAiSessionGateway(transport: AiRequest): SessionGateway {
  const request = aiRequest(transport);
  const unsupported = () => { throw new ApiError('protocol', 'unsupported_ai_session_action', 'AI 实时会话不发送终端字节'); };
  return {
    definitions: (signal) => request({ path: '/api/v2/session-definitions' }, signal),
    list: (signal) => request({ path: '/api/v2/sessions' }, signal),
    open(input, signal) {
      if (input.operation !== 'plugin.ai-sdk.sdk.stream' && input.operation !== 'plugin.ai-assistant.cli.stream')
        throw new ApiError('protocol', 'not_ai_stream', 'AI 插件只打开声明的 AI 实时操作');
      return request({ path: '/api/v2/sessions', method: 'POST', body: requireJson(input) }, signal);
    },
    get: (id, signal) => request({ path: sessionPath(id) }, signal),
    output(id, query, signal) {
      const after = query.after ?? 0, limit = query.limit ?? 50;
      if (!naturalNumber(after) || !naturalNumber(limit) || limit < 1 || limit > 100)
        throw new ApiError('protocol', 'invalid_session_query', '实时输出游标或页长无效');
      return request({ path: `${sessionPath(id)}/output?after=${after}&limit=${limit}` }, signal);
    },
    cancel: (id, signal) => request({ path: `${sessionPath(id)}/cancel`, method: 'POST' }, signal),
    release: (id, signal) => request({ path: `${sessionPath(id)}/release`, method: 'POST' }, signal),
    remove: (id, signal) => request({ path: sessionPath(id), method: 'DELETE' }, signal),
    send: unsupported, eof: unsupported,
  };
}

/** HTTP 蛇形执行元数据在边界映射，模型只消费公开 SDK 的驼峰目录。 */
export async function readAiOperations(transport: AiRequest, signal: AbortSignal) {
  const result = await aiRequest(transport)({ path: '/api/v2/operations' }, signal);
  if (!Array.isArray(result.data))
    throw new ApiError('protocol', 'invalid_ai_operations', 'AI 操作目录不是数组', null, result.logId);
  const data: Operation[] = result.data.map((raw) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id ||
        typeof raw.title !== 'string' || !isJsonData(raw.input_schema))
      throw new ApiError('protocol', 'invalid_ai_operations', 'AI 操作目录形状无效', null, result.logId);
    const value = raw.execution;
    if (value === undefined || value === null)
      return { id: raw.id, title: raw.title, input_schema: raw.input_schema };
    if (!isRecord(value) || value.api_version !== 1 || !naturalNumber(value.total_timeout_ms) ||
        value.total_timeout_ms < 1 || value.total_timeout_ms > 3600000 ||
        (value.source !== 'default' && value.source !== 'declared'))
      throw new ApiError('protocol', 'invalid_ai_operations', 'AI 操作执行预算无效', null, result.logId);
    return { id: raw.id, title: raw.title, input_schema: raw.input_schema,
      execution: { apiVersion: 1, totalTimeoutMs: value.total_timeout_ms, source: value.source } };
  });
  return { data, logId: result.logId };
}
