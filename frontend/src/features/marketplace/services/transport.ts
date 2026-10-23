import { ApiError } from '../../../services/api/index.ts';

const logHeader = 'x-deviceforge-log-id';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function waiting<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('请求等待已取消', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export async function marketplaceRequest(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  try {
    return await waiting(
      fetcher(input, {
        ...init,
        signal,
        credentials: 'omit',
        redirect: 'error',
      }),
      signal,
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw new ApiError('network', 'network_error', '无法取得市场服务器响应');
  }
}

export async function requireMarketplaceOk(
  response: Response,
  signal: AbortSignal,
  action: string,
): Promise<void> {
  signal.throwIfAborted();
  if (response.ok) return;
  let message = `HTTP ${response.status}`;
  let code = 'marketplace_http_error';
  let logId = response.headers.get(logHeader);
  try {
    const value: unknown = await waiting(response.json(), signal);
    if (record(value)) {
      if (!logId && typeof value['log_id'] === 'string' && value['log_id'].trim())
        logId = value['log_id'];
      if (record(value['error'])) {
        const detail = value['error'];
        if (typeof detail['message'] === 'string' && detail['message'].trim())
          message = detail['message'];
        if (typeof detail['code'] === 'string' && detail['code'].trim()) code = detail['code'];
      }
    }
  } catch {
    signal.throwIfAborted();
    // HEAD 及非 JSON 错误响应保留状态与关联头。
  }
  signal.throwIfAborted();
  throw new ApiError(
    'http',
    code,
    `${action}失败：${message}`,
    response.status,
    logId,
    response.headers.get('retry-after'),
  );
}

export async function marketplaceJson(response: Response, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  try {
    return await waiting(response.json(), signal);
  } catch {
    signal.throwIfAborted();
    throw new ApiError(
      'protocol',
      'invalid_marketplace_response',
      '市场服务器返回的 JSON 无效',
      response.status,
      response.headers.get(logHeader),
    );
  }
}
