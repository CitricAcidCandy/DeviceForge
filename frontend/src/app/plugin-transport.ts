import { HostError } from '../plugin-sdk/models.ts';
import type { HostResult, JsonValue } from '../plugin-sdk/models.ts';
import type { PluginJsonRequest, PluginRequest, PluginTransport } from '../plugin-sdk/transport.ts';
import { isJsonValue } from '../plugin-sdk/json.ts';
import { ApiError, readApiEnvelope } from '../services/api/index.ts';
import type { ApiClient, RequestSpec } from '../services/api/index.ts';
import { abortable } from '../services/api/abort.ts';

const logHeader = 'x-deviceforge-log-id';
const reservedHeaders = /^(authorization|proxy-authorization|cookie|host|connection|origin|referer|set-cookie|x-deviceforge-plugin-release)$/i;

function requestSpec(input: PluginRequest): RequestSpec {
  if (!input.path.startsWith('/api/v2/') || input.path.includes('\\') || /[\u0000-\u0020]/.test(input.path))
    throw new HostError('protocol', 'invalid_transport_path', '请求地址必须是宿主公开的 /api/v2/ 相对路径');
  const path = input.path.split(/[?#]/, 1)[0] ?? '';
  if (input.path.includes('#') || path.split('/').some((part) => {
    try { const decoded = decodeURIComponent(part); return decoded === '.' || decoded === '..' || /[/\\]/.test(decoded); }
    catch { return true; }
  })) throw new HostError('protocol', 'invalid_transport_path', '请求地址包含无效或越界路径片段');
  if (input.body !== undefined && input.content !== undefined)
    throw new HostError('protocol', 'invalid_transport_body', 'JSON 正文与原始字节不能同时提供');
  if (input.body !== undefined && !isJsonValue(input.body))
    throw new HostError('protocol', 'invalid_transport_body', '请求正文必须是可序列化 JSON');
  const method = input.method ?? 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
    throw new HostError('protocol', 'invalid_transport_method', '请求方法不在公开契约内');
  if (method === 'GET' && (input.body !== undefined || input.content !== undefined))
    throw new HostError('protocol', 'invalid_transport_body', '读取请求不能携带正文');
  const headers = new Headers(input.headers);
  for (const name of headers.keys()) {
    if (reservedHeaders.test(name)) throw new HostError('protocol', 'reserved_transport_header', '连接凭据与保留请求头由宿主管理');
  }
  return {
    path: input.path, method,
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.body !== undefined ? { body: JSON.stringify(input.body), contentType: 'application/json' }
      : input.content !== undefined ? { body: input.content } : {}),
    ...(input.body === undefined && input.contentType ? { contentType: input.contentType } : {}),
  };
}

function requestSignal(input: PluginRequest, signal: AbortSignal): AbortSignal {
  const timeout = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
    throw new HostError('protocol', 'invalid_transport_timeout', '请求期限必须为 1 至 300000 毫秒');
  return AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
}

function publicError(error: unknown, signal: AbortSignal, logId: string | null = null): HostError {
  logId ??= error instanceof ApiError || error instanceof HostError ? error.logId : null;
  if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')
    return new HostError('protocol', 'request_timeout', '请求期限已到，后台执行结果需另行查询', logId);
  if (signal.aborted) return new HostError('cancelled', 'cancelled', '请求等待已取消，后台执行结果需另行查询', logId);
  if (error instanceof HostError) return error;
  if (error instanceof ApiError)
    return new HostError(error.kind, error.code, error.message, error.logId, error.status, error.retryAfter);
  return new HostError('network', 'transport_read_failed', '无法读取服务器响应', logId);
}

/** 只适配现有客户端；连接、令牌及发布修订仍由原客户端负责。 */
export function createPluginTransport(client: ApiClient): PluginTransport {
  async function raw(input: PluginRequest, signal: AbortSignal): Promise<Response> {
    if (!client.request) throw new HostError('protocol', 'transport_unavailable', '当前客户端尚未提供公开原始请求通路');
    const response = await abortable(client.request(requestSpec(input), signal), signal);
    if (!response.ok) await readApiEnvelope(response, signal);
    return response;
  }
  async function request(input: PluginJsonRequest, caller: AbortSignal): Promise<HostResult<JsonValue>> {
    const signal = requestSignal(input, caller);
    let logId: string | null = null;
    try {
      if (input.envelope !== undefined && input.envelope !== 'v2' && input.envelope !== 'raw')
        throw new HostError('protocol', 'invalid_transport_envelope', 'JSON 响应包装类型无效');
      const spec = requestSpec(input);
      if (input.envelope !== 'raw') {
        // v2 JSON 直接使用原 call，保留发布修订解析、错误包装及日志一致性校验。
        return await abortable(client.call({ request: () => spec, decode: isJsonValue }, undefined, signal), signal);
      }
      const response = await raw(input, signal);
      logId = response.headers.get(logHeader);
      const data: unknown = await abortable(response.json(), signal);
      if (!isJsonValue(data)) throw new HostError('protocol', 'invalid_response', '服务器没有返回公开 JSON 值', logId);
      return { data, logId };
    } catch (error) { throw publicError(error, signal, logId); }
  }
  async function bytes(input: PluginRequest, caller: AbortSignal): Promise<HostResult<Blob>> {
    const signal = requestSignal(input, caller);
    let logId: string | null = null;
    try {
      const response = await raw(input, signal);
      logId = response.headers.get(logHeader);
      const data = await abortable(response.blob(), signal);
      return { data, logId };
    } catch (error) { throw publicError(error, signal, logId); }
  }
  async function stream(input: PluginRequest, caller: AbortSignal): Promise<HostResult<ReadableStream<Uint8Array>>> {
    const signal = requestSignal(input, caller);
    let logId: string | null = null;
    try {
      const response = await raw(input, signal);
      logId = response.headers.get(logHeader);
      const body = response.body;
      if (!body) throw new HostError('protocol', 'stream_unavailable', '服务器没有提供可读内容', logId);
      const reader = body.getReader();
      let finished = false;
      let output: ReadableStreamDefaultController<Uint8Array>;
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      const finish = () => { finished = true; signal.removeEventListener('abort', abort); };
      const abort = () => {
        if (finished) return;
        finish();
        cancel();
        output.error(publicError(null, signal, logId));
      };
      const data = new ReadableStream<Uint8Array>({
        start(controller) { output = controller; signal.addEventListener('abort', abort, { once: true }); },
        async pull(controller) {
          try {
            if (signal.aborted) { abort(); return; }
            const item = await abortable(reader.read(), signal);
            if (finished) return;
            if (item.done) { finish(); controller.close(); }
            else controller.enqueue(item.value);
          } catch (error) {
            if (finished) return;
            finish(); cancel(); controller.error(publicError(error, signal, logId));
          }
        },
        cancel() { finish(); cancel(); },
      });
      if (signal.aborted) abort();
      return { data, logId };
    } catch (error) { throw publicError(error, signal, logId); }
  }
  return Object.freeze<PluginTransport>({ request, bytes, stream });
}
