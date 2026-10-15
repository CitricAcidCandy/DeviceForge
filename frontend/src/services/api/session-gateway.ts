import { ApiError } from './errors.ts';
import { encodedId } from './endpoints.ts';
import type { paths } from './generated.ts';
import type { ApiClient, ApiResult, Endpoint } from './types.ts';
import { isRecord } from './validation.ts';
import { isOperationExecution } from './operation-execution-validation.ts';
import { isArtifactMetadata } from './artifact-queries.ts';
import { isJsonData, naturalNumber } from '../../shared/jobs/values.ts';

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
function path(id: string): string {
  return `/api/v2/sessions/${encodedId(normalizeSessionId(id))}`;
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
const definitionsEndpoint: Endpoint<void, SessionDefinitions> = {
  request: () => ({ path: '/api/v2/session-definitions', method: 'GET' }),
  decode: isSessionDefinitions,
};
const recordsEndpoint: Endpoint<void, SessionInfo[]> = {
  request: () => ({ path: '/api/v2/sessions', method: 'GET' }),
  decode: (value): value is SessionInfo[] =>
    Array.isArray(value) && value.length <= 8 && value.every(isSessionInfo),
};
const openEndpoint: Endpoint<SessionOpenInput, SessionInfo> = {
  request: (input) => ({
    path: '/api/v2/sessions',
    method: 'POST',
    body: JSON.stringify(input),
    contentType: 'application/json',
  }),
  decode: isSessionInfo,
};
const detailEndpoint: Endpoint<SessionPath, SessionInfo> = {
  request: ({ id }) => ({ path: path(id), method: 'GET' }),
  decode: isSessionInfo,
};
const outputEndpoint: Endpoint<
  SessionPath & { readonly query: SessionOutputQuery },
  SessionOutputPage
> = {
  request: ({ id, query }) => {
    const after = query.after ?? 0;
    const limit = query.limit ?? 50;
    if (!naturalNumber(after) || !naturalNumber(limit) || limit < 1 || limit > 100)
      throw new ApiError(
        'protocol',
        'invalid_session_query',
        '输出游标须为非负安全整数，页长须为1至100',
      );
    return { path: `${path(id)}/output?after=${after}&limit=${limit}`, method: 'GET' };
  },
  decode: isSessionOutputPage,
};
const inputEndpoint: Endpoint<SessionPath & SessionBytesInput, SessionReceipt> = {
  request: ({ id, bytes }) => {
    if (!isSessionBytes(bytes))
      throw new ApiError(
        'protocol',
        'invalid_session_bytes',
        '会话输入须为不超过8192项的原字节数组',
      );
    return {
      path: `${path(id)}/input`,
      method: 'POST',
      body: JSON.stringify({ bytes }),
      contentType: 'application/json',
    };
  },
  decode: isSessionReceipt,
};
const eofEndpoint: Endpoint<SessionPath, SessionReceipt> = {
  request: ({ id }) => ({ path: `${path(id)}/eof`, method: 'POST' }),
  decode: isSessionReceipt,
};
const cancelEndpoint: Endpoint<SessionPath, SessionInfo> = {
  request: ({ id }) => ({ path: `${path(id)}/cancel`, method: 'POST' }),
  decode: isSessionInfo,
};
const releaseEndpoint: Endpoint<SessionPath, SessionInfo> = {
  request: ({ id }) => ({ path: `${path(id)}/release`, method: 'POST', keepalive: true }),
  decode: isSessionInfo,
};
const removeEndpoint: Endpoint<SessionPath, SessionRemoved> = {
  request: ({ id }) => ({ path: path(id), method: 'DELETE' }),
  decode: isSessionRemoved,
};
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
export function createHttpSessionGateway(client: ApiClient): SessionGateway {
  return {
    definitions: (signal) => client.call(definitionsEndpoint, undefined, signal),
    list: (signal) => client.call(recordsEndpoint, undefined, signal),
    open: (input, signal) => client.call(openEndpoint, input, signal),
    get: (id, signal) => client.call(detailEndpoint, { id }, signal),
    output: (id, query, signal) => client.call(outputEndpoint, { id, query }, signal),
    send: (id, bytes, signal) => client.call(inputEndpoint, { id, bytes: [...bytes] }, signal),
    eof: (id, signal) => client.call(eofEndpoint, { id }, signal),
    cancel: (id, signal) => client.call(cancelEndpoint, { id }, signal),
    release: (id, signal) => client.call(releaseEndpoint, { id }, signal),
    remove: (id, signal) => client.call(removeEndpoint, { id }, signal),
  };
}
