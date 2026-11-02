import { ApiError, readHostError } from '@deviceforge/plugin-sdk';
import type { Artifact, HostResult, Operation, OperationExecution } from '@deviceforge/plugin-sdk';
export { ApiError } from '@deviceforge/plugin-sdk';

export type ApiResult<T> = HostResult<T>;
export type OperationDto = Operation;
export type ArtifactDto = Artifact;

export function apiError(error: unknown): unknown {
  const fields = readHostError(error);
  if (!fields) return error;
  try { if (error instanceof ApiError) return error; }
  catch { return error; }
  return new ApiError(fields.kind, fields.code, fields.message, fields.status, fields.logId, fields.retryAfter);
}

function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return isRecord(value) && Object.values(value).every(jsonValue);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isExecution(value: unknown): value is OperationExecution {
  return isRecord(value) && value.apiVersion === 1 &&
    typeof value.totalTimeoutMs === 'number' && Number.isSafeInteger(value.totalTimeoutMs) &&
    value.totalTimeoutMs > 0 && (value.source === 'default' || value.source === 'declared');
}
export function isOperation(value: unknown): value is Operation {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.title === 'string' && Object.hasOwn(value, 'input_schema') &&
    jsonValue(value.input_schema) &&
    (value.execution === undefined || isExecution(value.execution));
}

/** 注入方忽略取消时仍结束等待；不把等待取消宣称为服务器任务已取消。 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ApiError('cancelled', 'cancelled', '请求等待已取消'));
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
