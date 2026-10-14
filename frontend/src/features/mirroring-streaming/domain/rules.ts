import { ApiError, isSessionDefinitions, isSessionInfo, isSessionOutputPage, isSessionReceipt, normalizeSessionId } from '../../../shared/api/index.ts';
import type { SessionInfo, SessionOutputPage, SessionReceipt } from '../../../shared/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';
import type { MirroringControl, MirroringDefinitionsView, MirroringOutputOptions, MirroringStreamInput } from './types.ts';
import { invalidStream } from './errors.ts';

export const MIRRORING_OPEN = 'plugin.mirroring.open';
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
export function copyFrozen<T>(value: T): T { const copy = structuredClone(value); freeze(copy); return copy; }
function unicode(value: string): boolean {
  for (let index = 0; index < value.length; ++index) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function integer(value: unknown, minimum: number, maximum: number): value is number { return naturalNumber(value) && value >= minimum && value <= maximum; }
function optional(value: Record<string, unknown>, key: string, check: (value: unknown) => boolean): boolean { return !Object.hasOwn(value, key) || check(value[key]); }
function isStreamInput(value: unknown): value is MirroringStreamInput {
  return jsonObject(value) && onlyKeys(value, ['device_id', 'max_size', 'max_fps', 'video_bit_rate', 'audio', 'control', 'reconnect_attempts'])
    && typeof value.device_id === 'string' && value.device_id.length <= 200 && /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(value.device_id)
    && optional(value, 'max_size', (item) => integer(item, 64, 4096)) && optional(value, 'max_fps', (item) => integer(item, 1, 60))
    && optional(value, 'video_bit_rate', (item) => integer(item, 128000, 16000000)) && optional(value, 'reconnect_attempts', (item) => integer(item, 0, 5))
    && optional(value, 'audio', (item) => typeof item === 'boolean') && optional(value, 'control', (item) => typeof item === 'boolean');
}
export function normalizeStreamInput(value: unknown): MirroringStreamInput {
  if (!isStreamInput(value)) throw invalidStream('投屏直播设备或编码、控制、重连参数无效');
  return copyFrozen(value);
}
function text(value: unknown, maxBytes: number): boolean { return typeof value === 'string' && !value.includes('\0') && unicode(value) && new TextEncoder().encode(value).length <= maxBytes; }
function isMirroringControl(value: unknown): value is MirroringControl {
  if (!jsonObject(value)) return false;
  let valid = false;
  if (value.type === 'touch') valid = onlyKeys(value, ['type', 'action', 'pointer_id', 'x', 'y', 'width', 'height', 'pressure'])
    && (value.action === 'down' || value.action === 'up' || value.action === 'move') && integer(value.width, 1, 65535) && integer(value.height, 1, 65535)
    && integer(value.x, 0, value.width - 1) && integer(value.y, 0, value.height - 1)
    && optional(value, 'pointer_id', (item) => integer(item, 0, 9))
    && optional(value, 'pressure', (item) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1);
  else if (value.type === 'key') valid = onlyKeys(value, ['type', 'action', 'keycode', 'repeat', 'meta_state']) && (value.action === 'down' || value.action === 'up')
    && integer(value.keycode, 0, 320) && optional(value, 'repeat', (item) => integer(item, 0, 1000)) && optional(value, 'meta_state', (item) => integer(item, 0, 2147483647));
  else if (value.type === 'text') valid = onlyKeys(value, ['type', 'text']) && text(value.text, 300);
  else if (value.type === 'clipboard') valid = onlyKeys(value, ['type', 'text', 'paste']) && text(value.text, 2048) && optional(value, 'paste', (item) => typeof item === 'boolean');
  else if (value.type === 'rotate' || value.type === 'reset_video') valid = onlyKeys(value, ['type']);
  return valid;
}
export function normalizeMirroringControl(value: unknown): MirroringControl {
  if (!isMirroringControl(value)) throw invalidStream('投屏触摸、按键、文本或剪贴板控制参数无效');
  return copyFrozen(value);
}
export function encodeMirroringControl(value: unknown, epoch: number): readonly number[] {
  if (!integer(epoch, 1, 0xffffffff)) throw invalidStream('投屏控制须绑定已观察到的有效连接代次');
  const copied = normalizeMirroringControl(value);
  const bytes = new TextEncoder().encode(`${JSON.stringify({ ...copied, epoch })}\n`);
  if (bytes.length > 4096) throw invalidStream('投屏控制编码后超出单行 4096 字节');
  return Object.freeze(Array.from(bytes));
}
export function decodeStreamDefinitions(value: unknown, logId: string | null): MirroringDefinitionsView {
  if (!isSessionDefinitions(value) || new Set(value.sessions.map((entry) => entry.id)).size !== value.sessions.length
    || value.sessions.some((entry) => !jsonObject(entry.input_schema) || entry.input_schema.type !== 'object')) throw invalidStream('投屏会话目录无效', logId);
  return copyFrozen(value);
}
export function decodeStreamInfo(value: unknown, logId: string | null, identity?: Readonly<SessionInfo>): Readonly<SessionInfo> {
  if (!isSessionInfo(value) || value.operation !== MIRRORING_OPEN || value.plugin_id !== 'mirroring') throw invalidStream('响应不属于投屏直播会话', logId);
  if (identity && (normalizeSessionId(value.id) !== identity.id || value.operation !== identity.operation || value.plugin_id !== identity.plugin_id
    || value.generation !== identity.generation || value.created_at !== identity.created_at)) throw invalidStream('投屏会话身份或提供者代次不一致', logId);
  return copyFrozen({ ...value, id: normalizeSessionId(value.id) });
}
export function decodeStreamPage(value: unknown, identity: Readonly<SessionInfo>, after: number, limit: number, logId: string | null): SessionOutputPage {
  if (!isSessionOutputPage(value)) throw invalidStream('投屏输出页形状无效', logId);
  const session = decodeStreamInfo(value.session, logId, identity);
  const expected = Math.min(limit, session.output_sequence - after);
  if (expected < 0 || value.chunks.length !== expected || value.next_sequence !== after + expected
    || value.chunks.some((chunk, index) => chunk.sequence !== after + index + 1 || chunk.stream !== 'stdout')) throw invalidStream('投屏输出缺块、重排、越界或包含未声明诊断通道', logId);
  return copyFrozen({ ...value, session });
}
export function decodeStreamReceipt(value: unknown, id: string, logId: string | null): SessionReceipt {
  if (!isSessionReceipt(value) || normalizeSessionId(value.id) !== id || !value.accepted) throw invalidStream('投屏输入或 EOF 收据不匹配', logId);
  return copyFrozen(value);
}
export function streamReadLimit(options: MirroringOutputOptions): number {
  if (!jsonObject(options) || !onlyKeys(options, ['limit'])) throw invalidStream('投屏输出读取只接受页长');
  const value = options.limit ?? 50;
  if (!integer(value, 1, 100)) throw invalidStream('投屏输出页长须为 1 至 100');
  return value;
}
export function streamPollInterval(value: number | undefined): number {
  const interval = value ?? 25;
  if (!integer(interval, 1, 60000)) throw invalidStream('投屏轮询间隔须为 1 至 60000 毫秒');
  return interval;
}
export function streamError(error: unknown, logId: string | null = null): ApiError {
  if (error instanceof ApiError) return error.logId !== null || logId === null ? error : new ApiError(error.kind, error.code, error.message, error.status, logId, error.retryAfter);
  return new ApiError('network', 'mirroring_stream_failed', '投屏直播消费失败', null, logId);
}
