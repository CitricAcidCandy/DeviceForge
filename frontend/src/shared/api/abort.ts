import { ApiError } from './errors.ts';

// 即使注入的传输或令牌提供器忽略信号，也及时结束客户端等待。
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ApiError('cancelled', 'cancelled', '请求等待已取消'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
