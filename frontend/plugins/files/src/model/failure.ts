import type { FileFailure, FileFailureConstructor } from './types.ts';

/** 默认错误不依赖宿主类，旧入口可以显式注入兼容构造器。 */
export class FileError extends Error implements FileFailure {
  readonly kind: FileFailure['kind'];
  readonly code: string;
  readonly status: number | null;
  readonly logId: string | null;
  readonly retryAfter: string | null;
  constructor(
    kind: FileFailure['kind'], code: string, message: string,
    status: number | null = null, logId: string | null = null,
    retryAfter: string | null = null,
  ) {
    super(message);
    this.name = 'FileError';
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.logId = logId;
    this.retryAfter = retryAfter;
  }
}

export function queryFailure(error: unknown, Failure: FileFailureConstructor): FileFailure {
  if (error instanceof Failure) return error;
  if (error instanceof Error && 'kind' in error && 'code' in error &&
    (error.kind === 'http' || error.kind === 'network' ||
      error.kind === 'cancelled' || error.kind === 'protocol') &&
    typeof error.code === 'string') {
    return new Failure(
      error.kind, error.code, error.message,
      'status' in error && typeof error.status === 'number' ? error.status : null,
      'logId' in error && typeof error.logId === 'string' ? error.logId : null,
      'retryAfter' in error && typeof error.retryAfter === 'string' ? error.retryAfter : null,
    );
  }
  return new Failure('network', 'artifact_query_failed', '无法取得产物查询响应');
}

export function waitFor<T>(
  promise: Promise<T>, signal: AbortSignal, Failure: FileFailureConstructor,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Failure('cancelled', 'cancelled', '请求等待已取消'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}
