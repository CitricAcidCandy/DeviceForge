import { ApiError } from '../api/index.ts';
import { isSchemaValue } from '../../utils/schema.ts';

export const MAX_MESSAGE_BYTES = 1024 * 1024 + 16 * 1024;
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function realtimeFailure(code: string, message: string) {
  return new ApiError('protocol', code, message);
}
export function messageBytes(value: unknown): number {
  if (!isSchemaValue(value)) throw realtimeFailure('realtime_invalid_message', '实时消息必须是有限的 JSON');
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_MESSAGE_BYTES) throw realtimeFailure('realtime_message_too_large', '实时消息超过当前传输大小限制');
  return bytes;
}
/** 实时通道沿用 v2 关联结构，不用命令编号代替日志编号。 */
export function readRealtimeEnvelope(value: unknown): unknown {
  messageBytes(value);
  if (!record(value) || typeof value.log_id !== 'string' || !value.log_id.trim() || value.log_id.length > 128)
    throw realtimeFailure('realtime_invalid_response', '实时响应缺少有效日志 ID');
  if (record(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string')
    throw new ApiError('http', value.error.code, value.error.message, null, value.log_id);
  if (!Object.hasOwn(value, 'data')) throw realtimeFailure('realtime_invalid_response', '实时响应缺少数据');
  return value.data;
}
