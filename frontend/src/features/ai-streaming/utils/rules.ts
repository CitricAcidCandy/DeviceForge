import { ApiError, isSessionDefinitions, isSessionInfo, isSessionOutputPage, normalizeSessionId } from '../../../shared/api/index.ts';
import type { SessionDefinitions, SessionInfo, SessionOutputPage } from '../../../shared/api/index.ts';
import { decimalU64, jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/values.ts';
import type { AiStreamInput, AiStreamOwner, AiStreamReadOptions, AiStreamResult } from '../types/index.ts';

export const aiStreamOperation = 'plugin.ai-assistant.cli.stream';
const encoder = new TextEncoder();
const rustWhitespace = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
export const utf8Length = (text: string): number => encoder.encode(text).length;
export function validUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export const hasContent = (text: string): boolean => !rustWhitespace.test(text);
export function invalidStream(logId: string | null): ApiError {
  return new ApiError('protocol', 'invalid_ai_stream', 'AI实时输出不符合公开事件、顺序或归属契约', null, logId);
}
export function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}
export function copyFrozen<T>(value: T): T {
  const copied: T = structuredClone(value);
  return freezeValue(copied);
}
export function normalizeOwner(value: AiStreamOwner): AiStreamOwner {
  if (!jsonObject(value) || !onlyKeys(value, ['project_id', 'thread_id']) || typeof value.project_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(value.project_id)
    || Object.hasOwn(value, 'thread_id') && typeof value.thread_id !== 'string') throw invalidStream(null);
  return Object.freeze(value.thread_id === undefined ? { project_id: value.project_id } : { project_id: value.project_id, thread_id: normalizeSessionId(value.thread_id) });
}
export function normalizeInput(value: AiStreamInput): AiStreamInput {
  if (!jsonObject(value) || !onlyKeys(value, ['project_id', 'prompt', 'thread_id']) || typeof value.prompt !== 'string'
    || !validUnicode(value.prompt) || !hasContent(value.prompt) || Array.from(value.prompt).length > 131072
    || Object.hasOwn(value, 'thread_id') && typeof value.thread_id !== 'string') throw invalidStream(null);
  const owner = normalizeOwner(typeof value.thread_id === 'string' ? { project_id: value.project_id, thread_id: value.thread_id } : { project_id: value.project_id });
  return Object.freeze({ ...owner, prompt: value.prompt });
}
export function decodeDefinitions(value: unknown, logId: string | null): SessionDefinitions {
  if (!isSessionDefinitions(value) || new Set(value.sessions.map((entry) => entry.id)).size !== value.sessions.length) throw invalidStream(logId);
  return copyFrozen(value);
}
export function decodeInfo(value: unknown, logId: string | null, expected?: Readonly<SessionInfo> | string): SessionInfo {
  if (!isSessionInfo(value) || value.operation !== aiStreamOperation) throw invalidStream(logId);
  const data = copyFrozen({ ...value, id: normalizeSessionId(value.id) });
  if (typeof expected === 'string' && data.id !== expected) throw invalidStream(logId);
  if (typeof expected === 'object' && (data.id !== expected.id || data.operation !== expected.operation || data.plugin_id !== expected.plugin_id
    || data.generation !== expected.generation || data.created_at !== expected.created_at)) throw invalidStream(logId);
  return data;
}
export function decodeRecords(value: unknown, logId: string | null): readonly SessionInfo[] {
  if (!Array.isArray(value) || value.length > 8 || !value.every(isSessionInfo)) throw invalidStream(logId);
  const records: SessionInfo[] = value;
  if (new Set(records.map((entry) => normalizeSessionId(entry.id))).size !== records.length) throw invalidStream(logId);
  return copyFrozen(records.filter((entry) => entry.operation === aiStreamOperation).map((entry) => ({ ...entry, id: normalizeSessionId(entry.id) })));
}
export function readLimit(options: AiStreamReadOptions): number {
  const limit = options.limit ?? 50;
  if (!naturalNumber(limit) || limit < 1 || limit > 100) throw invalidStream(null);
  return limit;
}
export function decodePage(value: unknown, identity: Readonly<SessionInfo>, after: number, limit: number, logId: string | null): SessionOutputPage {
  if (!isSessionOutputPage(value)) throw invalidStream(logId);
  const session = decodeInfo(value.session, logId, identity);
  if (session.output_sequence < after || value.chunks.length !== Math.min(limit, session.output_sequence - after)
    || value.next_sequence !== after + value.chunks.length || value.chunks.some((chunk, index) => chunk.sequence !== after + index + 1 || chunk.stream !== 'stdout')) throw invalidStream(logId);
  return copyFrozen({ ...value, session });
}
export function decodeResult(value: unknown, projectId: string, threadId: string | null, text: string, logId: string | null): AiStreamResult {
  if (!jsonObject(value) || !onlyKeys(value, ['project_id', 'thread_id', 'text', 'turns', 'stream_format_version', 'provider', 'resource_scope'])
    || value.project_id !== projectId || value.thread_id !== threadId || typeof value.text !== 'string' || value.text !== text
    || !hasContent(value.text) || !validUnicode(value.text) || utf8Length(value.text) > 512 * 1024
    || !decimalU64(value.turns) || value.turns === '0' || value.stream_format_version !== 1 || value.provider !== 'codex_cli' || value.resource_scope !== 'direct_process'
    || typeof value.thread_id !== 'string') throw invalidStream(logId);
  return Object.freeze({ project_id: projectId, thread_id: value.thread_id, text: value.text, turns: value.turns, stream_format_version: 1, provider: 'codex_cli', resource_scope: 'direct_process' });
}
export function streamError(error: unknown, logId: string | null = null): ApiError {
  if (error instanceof ApiError) return error.logId === null && logId !== null ? new ApiError(error.kind, error.code, error.message, error.status, logId, error.retryAfter) : error;
  return new ApiError('network', 'ai_stream_request_failed', 'AI实时会话请求未完成', null, logId);
}
export function pollInterval(value: number | undefined): number {
  const interval = value ?? 250;
  if (!naturalNumber(interval) || interval > 60000) throw invalidStream(null);
  return interval;
}
