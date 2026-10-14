import { ApiError, isSessionBytes, isSessionDefinitions, isSessionInfo, isSessionOutputPage, isSessionReceipt, isSessionRemoved, normalizeSessionId } from '../../../shared/api/index.ts';
import type { SessionInfo, SessionOpenInput, SessionOutputPage, SessionOutputQuery, SessionReceipt, SessionRemoved } from '../../../shared/api/index.ts';
import { isRecord } from '../../../shared/api/validation.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';
import type { SessionDefinitionsView, SessionInfoView, SessionReadOptions } from './types.ts';

type Identity = Pick<SessionInfo, 'id'> & Partial<Pick<SessionInfo, 'operation' | 'plugin_id' | 'generation' | 'created_at'>>;
function invalid(message: string, logId: string | null = null): ApiError { return new ApiError('protocol', 'invalid_session_response', message, null, logId); }
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
export function cloneFrozen<T>(value: T): T { const copy = structuredClone(value); freeze(copy); return copy; }
function validOperation(id: string): boolean { return id.length <= 128 && /^plugin\.[a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+$/.test(id); }
export function decodeDefinitions(value: unknown, logId: string | null): SessionDefinitionsView {
  if (!isSessionDefinitions(value) || value.sessions.some((entry) => !validOperation(entry.id) || !isRecord(entry.input_schema) || entry.input_schema.type !== 'object')
    || new Set(value.sessions.map((entry) => entry.id)).size !== value.sessions.length) throw invalid('会话目录身份或输入模式无效', logId);
  return cloneFrozen(value);
}
export function decodeInfo(value: unknown, logId: string | null, identity?: Identity): SessionInfoView {
  if (!isSessionInfo(value) || !validOperation(value.operation) || !value.operation.startsWith(`plugin.${value.plugin_id}.`)) throw invalid('会话身份、序号或终态证据无效', logId);
  if (identity && (normalizeSessionId(value.id) !== normalizeSessionId(identity.id)
    || identity.operation !== undefined && value.operation !== identity.operation
    || identity.plugin_id !== undefined && value.plugin_id !== identity.plugin_id
    || identity.generation !== undefined && value.generation !== identity.generation
    || identity.created_at !== undefined && value.created_at !== identity.created_at)) throw invalid('会话身份或所属代次不匹配', logId);
  return cloneFrozen({ ...value, id: normalizeSessionId(value.id) });
}
export function decodeRecords(value: unknown, logId: string | null): readonly SessionInfoView[] {
  if (!Array.isArray(value) || value.length > 8) throw invalid('会话记录目录无效', logId);
  const records = value.map((entry: unknown) => decodeInfo(entry, logId));
  if (new Set(records.map((entry) => entry.id)).size !== records.length) throw invalid('会话记录包含重复身份', logId);
  return Object.freeze(records);
}
export function normalizeOpen(input: SessionOpenInput, definitions: SessionDefinitionsView | null): SessionOpenInput {
  if (!isRecord(input) || !onlyKeys(input, ['operation', 'input']) || typeof input.operation !== 'string' || !validOperation(input.operation)
    || !jsonObject(input.input)) throw invalid('打开会话须使用公开操作与 JSON 对象参数');
  if (!definitions?.sessions.some((entry) => entry.id === input.operation)) throw new ApiError('protocol', 'session_operation_unavailable', '请先刷新会话目录并选择已公开操作');
  if (input.operation === 'plugin.terminal.open') {
    if (!onlyKeys(input.input, ['profile']) || typeof input.input.profile !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.input.profile)) throw invalid('终端只接受部署命名的profile，不接受程序或启动参数');
  }
  return cloneFrozen(input);
}
export function normalizeRead(options: SessionReadOptions, after: number): Required<SessionOutputQuery> {
  if (!isRecord(options) || !onlyKeys(options, ['limit'])) throw invalid('输出读取只接受页长，由当前游标继续');
  const limit = options.limit ?? 50;
  if (!naturalNumber(after) || !naturalNumber(limit) || limit < 1 || limit > 100) throw invalid('输出游标须为非负安全整数，页长须为1至100');
  return Object.freeze({ after, limit });
}
export function copyBytes(bytes: readonly number[]): readonly number[] {
  if (!isSessionBytes(bytes)) throw invalid('会话输入须为不超过8192项的原字节数组');
  return Object.freeze([...bytes]);
}
export function decodePage(value: unknown, identity: SessionInfoView, query: Required<SessionOutputQuery>, logId: string | null): SessionOutputPage {
  if (!isSessionOutputPage(value)) throw invalid('会话输出页形状无效', logId);
  const session = decodeInfo(value.session, logId, identity);
  const expected = Math.min(query.limit, session.output_sequence - query.after);
  if (expected < 0 || value.chunks.length !== expected || value.next_sequence !== query.after + expected
    || value.chunks.some((chunk, index) => chunk.sequence !== query.after + index + 1)) throw invalid('输出页缺块、重排或游标不匹配', logId);
  return cloneFrozen({ ...value, session });
}
export function decodeReceipt(value: unknown, id: string, logId: string | null): SessionReceipt {
  if (!isSessionReceipt(value) || normalizeSessionId(value.id) !== id || !value.accepted) throw invalid('输入或EOF收据不匹配', logId);
  return cloneFrozen(value);
}
export function decodeRemoved(value: unknown, id: string, logId: string | null): SessionRemoved {
  if (!isSessionRemoved(value) || normalizeSessionId(value.id) !== id) throw invalid('删除会话收据不匹配', logId);
  return cloneFrozen(value);
}
const ranks = { opening: 0, running: 1, stopping: 2, finished: 3 };
export function mergeInfo(previous: SessionInfoView | null, next: SessionInfoView): SessionInfoView {
  if (!previous) return next;
  const latest = ranks[next.status] >= ranks[previous.status] ? next : previous;
  return cloneFrozen({ ...latest, output_sequence: Math.max(previous.output_sequence, next.output_sequence) });
}
export function sessionError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('network', 'session_request_failed', '无法取得会话请求响应');
}
export function pollInterval(value: number | undefined): number {
  const interval = value ?? 100;
  if (!naturalNumber(interval) || interval < 1 || interval > 60000) throw invalid('输出轮询间隔须为1至60000毫秒');
  return interval;
}
