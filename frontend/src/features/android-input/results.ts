import { HostError } from '../../plugin-sdk/index.ts';
import type { Job } from '../../plugin-sdk/index.ts';
import type { AndroidInputResult, AndroidUnicodeInput } from './types.ts';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

export function decodeAndroidInputResult(job: Job, input: AndroidUnicodeInput, bytes: number, deviceId: string, logId: string | null): AndroidInputResult {
  if (job.status === 'cancelled') throw new HostError('cancelled', 'cancelled', 'Android 输入任务已取消', logId);
  if (job.status !== 'succeeded') throw new HostError('http', 'android_input_failed', 'Android 输入任务失败', logId);
  if (job.status !== 'succeeded' || !object(job.result) || !keys(job.result, ['result', 'artifacts'])
    || !Array.isArray(job.result.artifacts) || job.result.artifacts.length !== 0 || !object(job.result.result)) {
    throw new HostError('protocol', 'invalid_android_input_result', 'Android 输入任务结果无效', logId);
  }
  const result = job.result.result;
  const unicode = Array.from(input.text).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
  const expected = unicode ? ['action', 'bytes', 'device_id', 'dispatched', 'transport'] : ['action', 'device_id', 'dispatched'];
  if (input.text.length === 0 || !keys(result, expected)
    || result.device_id !== deviceId || result.action !== 'text' || result.dispatched !== true) {
    throw new HostError('protocol', 'invalid_android_input_result', 'Android 输入结果字段无效', logId);
  }
  if (!unicode) return Object.freeze({ device_id: result.device_id, action: 'text', dispatched: true });
  if (!keys(result, ['action', 'bytes', 'device_id', 'dispatched', 'transport']) || result.transport !== 'adb_keyboard_base64'
    || !Number.isSafeInteger(result.bytes) || result.bytes !== bytes) throw new HostError('protocol', 'invalid_android_input_result', 'Android Unicode 输入结果字节或传输方式无效', logId);
  return Object.freeze({ device_id: result.device_id, action: 'text', transport: 'adb_keyboard_base64', bytes: result.bytes, dispatched: true });
}
