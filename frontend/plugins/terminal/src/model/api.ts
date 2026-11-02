import type { paths } from '@deviceforge/contracts/api';
import type { HostResult } from '@deviceforge/plugin-sdk';
import { ApiError, isRecord } from '@deviceforge/business-kit/api';
import { isJsonData, naturalNumber } from '@deviceforge/business-kit/jobs';
import { isArtifactMetadata, isOperationExecution } from './metadata.ts';
export { ApiError, apiError } from '@deviceforge/business-kit/api';
export type ApiResult<T> = HostResult<T>;

export type SessionDefinitions =
  paths['/api/v2/session-definitions']['get']['responses'][200]['content']['application/json']['data'];
export type SessionInfo =
  paths['/api/v2/sessions/{id}']['get']['responses'][200]['content']['application/json']['data'];
export type SessionOutputPage =
  paths['/api/v2/sessions/{id}/output']['get']['responses'][200]['content']['application/json']['data'];
export type SessionOpenInput =
  paths['/api/v2/sessions']['post']['requestBody']['content']['application/json'];
export type SessionOutputQuery = NonNullable<
  paths['/api/v2/sessions/{id}/output']['get']['parameters']['query']
>;
export type SessionReceipt =
  paths['/api/v2/sessions/{id}/input']['post']['responses'][200]['content']['application/json']['data'];
export type SessionRemoved =
  paths['/api/v2/sessions/{id}']['delete']['responses'][200]['content']['application/json']['data'];
type SessionBytesInput =
  paths['/api/v2/sessions/{id}/input']['post']['requestBody']['content']['application/json'];
type SessionPath = paths['/api/v2/sessions/{id}']['parameters']['path'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nullable = (value: unknown, guard: (value: unknown) => boolean): boolean =>
  value === undefined || value === null || guard(value);
export function normalizeSessionId(id: string): string {
  if (typeof id !== 'string' || !uuid.test(id))
    throw new ApiError('protocol', 'invalid_session_id', '会话身份须为规范 UUID');
  return id.toLowerCase();
}
export function sessionPath(id: string): string {
  return `/api/v2/sessions/${encodeURIComponent(normalizeSessionId(id))}`;
}
export function isSessionBytes(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length > 8192) return false;
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; ++index) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    const byte: unknown = descriptor?.value;
    if (!descriptor?.enumerable || !naturalNumber(byte) || byte > 255) return false;
  }
  return true;
}
export function isSessionDefinitions(value: unknown): value is SessionDefinitions {
  return (
    isRecord(value) &&
    naturalNumber(value.revision) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(
      (entry: unknown) =>
        isRecord(entry) &&
        text(entry.id) &&
        text(entry.title) &&
        isRecord(entry.input_schema) &&
        isJsonData(entry.input_schema) &&
        isOperationExecution(entry.execution) &&
        (entry.output_retention === undefined ||
          entry.output_retention === 'complete' ||
          entry.output_retention === 'bounded_tail'),
    )
  );
}
function isCompletion(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.cleanup === 'complete' ||
      value.cleanup === 'failed' ||
      value.cleanup === 'unconfirmed') &&
    typeof value.process_exited === 'boolean' &&
    (value.cleanup !== 'complete' || value.process_exited) &&
    nullable(value.sequence, naturalNumber) &&
    nullable(
      value.failure,
      (failure) => isRecord(failure) && text(failure.code) && text(failure.message),
    ) &&
    nullable(
      value.outcome,
      (outcome) =>
        isRecord(outcome) &&
        Array.isArray(outcome.artifacts) &&
        outcome.artifacts.every(isArtifactMetadata) &&
        nullable(outcome.error, (error) => typeof error === 'string') &&
        (outcome.result === undefined || isJsonData(outcome.result)),
    )
  );
}
export function isSessionInfo(value: unknown): value is SessionInfo {
  return (
    isRecord(value) &&
    text(value.id) &&
    uuid.test(value.id) &&
    text(value.operation) &&
    text(value.plugin_id) &&
    text(value.generation) &&
    naturalNumber(value.created_at) &&
    naturalNumber(value.output_sequence) &&
    (value.status === 'opening' ||
      value.status === 'running' ||
      value.status === 'stopping' ||
      value.status === 'finished') &&
    (value.status === 'finished'
      ? isCompletion(value.completion)
      : value.completion === undefined || value.completion === null)
  );
}
export function isSessionOutputPage(value: unknown): value is SessionOutputPage {
  return (
    isRecord(value) &&
    isSessionInfo(value.session) &&
    naturalNumber(value.next_sequence) &&
    Array.isArray(value.chunks) &&
    value.chunks.length <= 100 &&
    value.chunks.every(
      (chunk: unknown) =>
        isRecord(chunk) &&
        naturalNumber(chunk.sequence) &&
        chunk.sequence >= 1 &&
        (chunk.stream === 'stdout' || chunk.stream === 'stderr') &&
        isSessionBytes(chunk.bytes),
    )
  );
}
export function isSessionReceipt(value: unknown): value is SessionReceipt {
  return (
    isRecord(value) && text(value.id) && uuid.test(value.id) && typeof value.accepted === 'boolean'
  );
}
export function isSessionRemoved(value: unknown): value is SessionRemoved {
  return isRecord(value) && text(value.id) && uuid.test(value.id);
}
export interface SessionGateway {
  readonly definitions: (signal: AbortSignal) => Promise<ApiResult<unknown>>;
  readonly list: (signal: AbortSignal) => Promise<ApiResult<unknown>>;
  readonly open: (input: SessionOpenInput, signal: AbortSignal) => Promise<ApiResult<unknown>>;
  readonly get: (id: string, signal: AbortSignal) => Promise<ApiResult<unknown>>;
  readonly output: (
    id: string,
    query: SessionOutputQuery,
    signal: AbortSignal,
  ) => Promise<ApiResult<unknown>>;
  readonly send: (
    id: string,
    bytes: readonly number[],
    signal: AbortSignal,
  ) => Promise<ApiResult<unknown>>;
  readonly eof: (id: string, signal: AbortSignal) => Promise<ApiResult<unknown>>;
  readonly cancel: (id: string, signal: AbortSignal) => Promise<ApiResult<unknown>>;
  readonly release: (id: string, signal: AbortSignal) => Promise<ApiResult<unknown>>;
  readonly remove: (id: string, signal: AbortSignal) => Promise<ApiResult<unknown>>;
}
