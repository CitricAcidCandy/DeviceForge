import { isRecord } from '../../../services/api/validation.ts';
import { decimalU64, onlyKeys } from '../../../shared/jobs/index.ts';
import { PROFILE_LIMITS, integer, invalidProfile, nullableText } from '../utils/rules.ts';
import type { StackFrame, StackSample } from '../types/index.ts';

const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(value);
function decodeFrame(value: unknown, logId: string | null): StackFrame {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['file', 'symbol', 'address', 'execution_type']) ||
    !nullableText(value.file) ||
    !nullableText(value.symbol) ||
    !hex(value.address) ||
    !(
      value.execution_type === 'native' ||
      value.execution_type === 'interpreted_jvm' ||
      value.execution_type === 'jit_jvm' ||
      value.execution_type === 'art'
    )
  )
    throw invalidProfile(logId);
  return {
    file: value.file,
    symbol: value.symbol,
    address: value.address,
    execution_type: value.execution_type,
  };
}
function decodeUnwinding(value: unknown, logId: string | null): StackSample['unwinding'] {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['raw_error_code', 'error_code', 'error_address']) ||
    !(value.raw_error_code === null || integer(value.raw_error_code, 0, 4294967295)) ||
    !(value.error_code === null || integer(value.error_code, 0, 4294967295)) ||
    !(value.error_address === null || hex(value.error_address))
  )
    throw invalidProfile(logId);
  return {
    raw_error_code: value.raw_error_code,
    error_code: value.error_code,
    error_address: value.error_address,
  };
}
export function decodeStackSample(value: unknown, logId: string | null): StackSample {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'time_ns',
      'thread_id',
      'process_id',
      'thread_name',
      'event_count',
      'event_type',
      'callchain',
      'unwinding',
    ]) ||
    !decimalU64(value.time_ns) ||
    !integer(value.thread_id, 0, 4294967295) ||
    !(value.process_id === null || integer(value.process_id, 0, 4294967295)) ||
    !nullableText(value.thread_name) ||
    !decimalU64(value.event_count) ||
    !nullableText(value.event_type) ||
    !Array.isArray(value.callchain) ||
    value.callchain.length > PROFILE_LIMITS.chain
  )
    throw invalidProfile(logId);
  return {
    time_ns: value.time_ns,
    thread_id: value.thread_id,
    process_id: value.process_id,
    thread_name: value.thread_name,
    event_count: value.event_count,
    event_type: value.event_type,
    callchain: value.callchain.map((frame: unknown) => decodeFrame(frame, logId)),
    unwinding: decodeUnwinding(value.unwinding, logId),
  };
}
// 行号固定为 zero-based；不重新排序，避免改变索引引用。保留叶到根链与未知符号。
export function decodeStackJsonLines(
  bytes: Uint8Array,
  logId: string | null = null,
  signal?: AbortSignal,
): readonly StackSample[] {
  if (bytes.byteLength > PROFILE_LIMITS.jsonlBytes) throw invalidProfile(logId);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const samples: StackSample[] = [];
  let start = 0;
  for (let end = 0; end <= bytes.length; end += 1) {
    if ((end & 4095) === 0) signal?.throwIfAborted();
    if (end !== bytes.length && bytes[end] !== 10) continue;
    if (end === bytes.length && start === end) break;
    if (end - start > PROFILE_LIMITS.lineBytes || samples.length >= PROFILE_LIMITS.stacks)
      throw invalidProfile(logId);
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(bytes.subarray(start, end)));
    } catch {
      throw invalidProfile(logId);
    }
    const sample = decodeStackSample(value, logId);
    const previous = samples[samples.length - 1];
    if (previous && BigInt(sample.time_ns) < BigInt(previous.time_ns)) throw invalidProfile(logId);
    samples.push(sample);
    start = end + 1;
  }
  signal?.throwIfAborted();
  return samples;
}
