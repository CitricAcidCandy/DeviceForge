import type { PluginJsonRequest, PluginTransport } from '@deviceforge/plugin-sdk';
import { apiError, ApiError, isRecord } from '@deviceforge/business-kit/api';
import { naturalNumber, requireJson } from '@deviceforge/business-kit/jobs';
import { isSessionBytes, sessionPath } from './api.ts';
import type { SessionGateway } from './api.ts';

/** 通信与清理共用公开 HTTP 契约；调用方显式传入对应寿命的请求能力。 */
export function createSessionGateway(transport: Pick<PluginTransport, 'request'>): SessionGateway {
  async function request(input: PluginJsonRequest, signal: AbortSignal) {
    try { return await transport.request(input, signal); }
    catch (error) { throw apiError(error); }
  }
  return {
    definitions: (signal) => request({ path: '/api/v2/session-definitions' }, signal),
    list: (signal) => request({ path: '/api/v2/sessions' }, signal),
    open(input, signal) {
      if (input.operation !== 'plugin.terminal.open' || !isRecord(input.input))
        throw new ApiError('protocol', 'not_terminal_operation', '终端插件只打开终端贡献');
      return request({ path: '/api/v2/sessions', method: 'POST', body: requireJson(input) }, signal);
    },
    get: (id, signal) => request({ path: sessionPath(id) }, signal),
    output(id, query, signal) {
      const after = query.after ?? 0, limit = query.limit ?? 50;
      if (!naturalNumber(after) || !naturalNumber(limit) || limit < 1 || limit > 100)
        throw new ApiError('protocol', 'invalid_session_query', '输出游标或页长无效');
      return request({ path: `${sessionPath(id)}/output?after=${after}&limit=${limit}` }, signal);
    },
    send(id, bytes, signal) {
      if (!isSessionBytes(bytes))
        throw new ApiError('protocol', 'invalid_session_bytes', '终端输入字节超出公开限制');
      return request({ path: `${sessionPath(id)}/input`, method: 'POST', body: { bytes: [...bytes] } }, signal);
    },
    eof: (id, signal) => request({ path: `${sessionPath(id)}/eof`, method: 'POST' }, signal),
    cancel: (id, signal) => request({ path: `${sessionPath(id)}/cancel`, method: 'POST' }, signal),
    release: (id, signal) => request({ path: `${sessionPath(id)}/release`, method: 'POST' }, signal),
    remove: (id, signal) => request({ path: sessionPath(id), method: 'DELETE' }, signal),
  };
}
