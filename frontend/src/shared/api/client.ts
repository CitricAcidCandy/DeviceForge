import { encodedId } from './endpoints.ts';
import { ApiError } from './errors.ts';
import type { ApiClient, ApiResult, Endpoint, RequestSpec } from './types.ts';
import { isRecord } from './validation.ts';
import { abortable } from './abort.ts';

export interface ClientOptions {
  readonly baseUrl: string;
  readonly transport: typeof fetch;
  readonly tokenProvider?: (signal: AbortSignal) => string | null | Promise<string | null>;
}
const logHeader = 'x-deviceforge-log-id';
function cancelled(logId: string | null = null): ApiError {
  return new ApiError('cancelled', 'cancelled', '请求等待已取消', null, logId);
}
function protocol(response: Response, message: string, logId: string | null = response.headers.get(logHeader)): ApiError {
  return new ApiError('protocol', 'invalid_response', message, response.status, logId);
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    const value: unknown = await abortable(response.json(), signal);
    if (signal.aborted) throw cancelled(response.headers.get(logHeader));
    return value;
  } catch (error) {
    if (signal.aborted || error instanceof ApiError && error.kind === 'cancelled') throw cancelled(response.headers.get(logHeader));
    throw protocol(response, '服务器未返回有效 JSON');
  }
}
function envelope(response: Response, value: unknown): { logId: string; data: unknown } {
  if (!isRecord(value) || typeof value.log_id !== 'string' || !value.log_id.trim()) throw protocol(response, 'v2 响应缺少日志 ID');
  const header = response.headers.get(logHeader);
  if (header && header !== value.log_id) throw protocol(response, '日志 ID 包装与响应头不一致');
  if (!response.ok) {
    if (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') throw protocol(response, 'v2 错误包装无效', value.log_id);
    throw new ApiError('http', value.error.code, value.error.message, response.status, value.log_id, response.headers.get('retry-after'));
  }
  if (!Object.hasOwn(value, 'data')) throw protocol(response, 'v2 成功包装缺少 data', value.log_id);
  return { logId: value.log_id, data: value.data };
}

export function createApiClient(options: ClientOptions): ApiClient {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('API 地址必须为不含凭证或查询参数的 HTTP 地址');
  async function request(spec: RequestSpec, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) throw cancelled();
    const url = new URL(spec.path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/v2/')) throw new Error('端点超出同源 v2 API 边界');
    const headers = new Headers({ accept: 'application/json' });
    if (spec.contentType) headers.set('content-type', spec.contentType);
    try {
      const token = await abortable(Promise.resolve(options.tokenProvider?.(signal) ?? null), signal);
      if (signal.aborted) throw cancelled();
      if (token) headers.set('authorization', `Bearer ${token}`);
      const response = await abortable(options.transport(url, {
        method: spec.method, headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        ...(spec.body === undefined ? {} : { body: spec.body }),
      }), signal);
      if (signal.aborted) throw cancelled(response.headers.get(logHeader));
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal.aborted) throw cancelled();
      // 不携带传输原始异常，避免地址、令牌或请求正文进入公共错误。
      throw new ApiError('network', 'network_error', '无法取得服务器响应');
    }
  }
  async function call<I, O>(endpoint: Endpoint<I, O>, input: I, signal: AbortSignal): Promise<ApiResult<O>> {
    const response = await request(endpoint.request(input), signal);
    const result = envelope(response, await json(response, signal));
    if (!endpoint.decode(result.data)) throw protocol(response, '业务响应不符合生成契约', result.logId);
    if (signal.aborted) throw cancelled(result.logId);
    return { data: result.data, logId: result.logId };
  }
  async function downloadArtifact(id: string, signal: AbortSignal): Promise<ApiResult<Blob>> {
    const response = await request({ path: `/api/v2/artifacts/${encodedId(id)}/content`, method: 'GET' }, signal);
    if (!response.ok) envelope(response, await json(response, signal));
    try {
      // 包括 application/json 产物在内，一律保留原字节。
      const data = await abortable(response.blob(), signal);
      if (signal.aborted) throw cancelled(response.headers.get(logHeader));
      return { data, logId: response.headers.get(logHeader) };
    } catch (error) {
      if (signal.aborted) throw cancelled(response.headers.get(logHeader));
      if (error instanceof ApiError) throw error;
      throw new ApiError('network', 'content_read_failed', '产物内容读取失败', response.status, response.headers.get(logHeader));
    }
  }
  return { call, downloadArtifact };
}
