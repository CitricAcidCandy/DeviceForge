import { isRecord } from '../../../shared/api/validation.ts';
import { decimalU64, onlyKeys } from '../../../shared/jobs/index.ts';
import { checkArchiveCancellation } from './cancellation.ts';
import { boundedText, integer, invalidProfile } from './rules.ts';
import type { ProfileResult, StackQuality, StackQualityCounts, StackSample } from '../types/index.ts';

const countKeys = ['reported_sample_count', 'parsed_sample_count', 'lost_count', 'callchain_frame_count', 'empty_callchain_sample_count', 'single_frame_sample_count', 'max_callchain_depth', 'unwinding_error_sample_count', 'unwinding_without_error_sample_count', 'unwinding_metadata_missing_sample_count', 'missing_symbol_frame_count', 'missing_symbol_sample_count'];
function counts(value: unknown, logId: string | null): StackQualityCounts {
  if (!isRecord(value) || !onlyKeys(value, countKeys) || !decimalU64(value.reported_sample_count) || !decimalU64(value.parsed_sample_count) || !decimalU64(value.lost_count)
    || !integer(value.callchain_frame_count, 0, 1000000) || !integer(value.empty_callchain_sample_count, 0, 100000) || !integer(value.single_frame_sample_count, 0, 100000) || !integer(value.max_callchain_depth, 0, 256)
    || !integer(value.unwinding_error_sample_count, 0, 100000) || !integer(value.unwinding_without_error_sample_count, 0, 100000) || !integer(value.unwinding_metadata_missing_sample_count, 0, 100000)
    || !integer(value.missing_symbol_frame_count, 0, 1000000) || !integer(value.missing_symbol_sample_count, 0, 100000)) throw invalidProfile(logId);
  return { reported_sample_count: value.reported_sample_count, parsed_sample_count: value.parsed_sample_count, lost_count: value.lost_count,
    callchain_frame_count: value.callchain_frame_count, empty_callchain_sample_count: value.empty_callchain_sample_count, single_frame_sample_count: value.single_frame_sample_count, max_callchain_depth: value.max_callchain_depth,
    unwinding_error_sample_count: value.unwinding_error_sample_count, unwinding_without_error_sample_count: value.unwinding_without_error_sample_count, unwinding_metadata_missing_sample_count: value.unwinding_metadata_missing_sample_count,
    missing_symbol_frame_count: value.missing_symbol_frame_count, missing_symbol_sample_count: value.missing_symbol_sample_count };
}
function reason(value: unknown): value is string { return boundedText(value) && value.length > 0; }
function errorCode(value: unknown): value is number | null { return value === null || integer(value, 0, 0xffffffff); }

// 质量文件只解释同一份栈报告，缺少错误字段不等于展开完整。
export function decodeStackQuality(bytes: Uint8Array, result: ProfileResult, stacks: readonly StackSample[], logId: string | null, signal?: AbortSignal): StackQuality {
  checkArchiveCancellation(signal, logId);
  if (bytes.length > 1024 * 1024 || result.stack_status !== 'captured') throw invalidProfile(logId);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalidProfile(logId); }
  if (!isRecord(value) || !onlyKeys(value, ['format_version', 'capture', 'counts', 'depth_histogram', 'unwinding_error_histogram', 'architecture', 'symbolication']) || value.format_version !== 1) throw invalidProfile(logId);
  const capture = value.capture; const architecture = value.architecture; const symbolication = value.symbolication;
  if (!isRecord(capture) || !onlyKeys(capture, ['mode', 'event', 'frequency_hz', 'clock', 'report_filter', 'remove_gaps'])
    || capture.mode !== 'dwarf' || capture.event !== 'cpu-clock' || capture.frequency_hz !== 99 || capture.clock !== 'boottime' || capture.report_filter !== 'disabled' || capture.remove_gaps !== 0
    || !isRecord(architecture) || !onlyKeys(architecture, ['status', 'device_arch', 'target_process_arch', 'reason']) || architecture.status !== 'unavailable' || architecture.device_arch !== null || architecture.target_process_arch !== null || !reason(architecture.reason)
    || !isRecord(symbolication) || !onlyKeys(symbolication, ['status', 'build_id_status', 'reason']) || symbolication.status !== 'reported_symbols_only' || symbolication.build_id_status !== 'unavailable' || !reason(symbolication.reason)) throw invalidProfile(logId);
  const actual = counts(value.counts, logId);
  if (!Array.isArray(value.depth_histogram) || value.depth_histogram.length > 257 || !Array.isArray(value.unwinding_error_histogram) || value.unwinding_error_histogram.length > 4096) throw invalidProfile(logId);
  const depths: { depth: number; count: number }[] = []; const errors: { raw_error_code: number | null; error_code: number | null; count: number }[] = [];
  for (const entry of value.depth_histogram) {
    if (!isRecord(entry) || !onlyKeys(entry, ['depth', 'count']) || !integer(entry.depth, 0, 256) || !integer(entry.count, 1, 100000) || depths.some(previous => previous.depth === entry.depth)) throw invalidProfile(logId);
    depths.push({ depth: entry.depth, count: entry.count });
  }
  for (const entry of value.unwinding_error_histogram) {
    checkArchiveCancellation(signal, logId);
    if (!isRecord(entry) || !onlyKeys(entry, ['raw_error_code', 'error_code', 'count']) || !errorCode(entry.raw_error_code) || !errorCode(entry.error_code) || !integer(entry.count, 1, 100000)
      || !(entry.raw_error_code !== null && entry.raw_error_code !== 0 || entry.error_code !== null && entry.error_code !== 0)
      || errors.some(previous => previous.raw_error_code === entry.raw_error_code && previous.error_code === entry.error_code)) throw invalidProfile(logId);
    errors.push({ raw_error_code: entry.raw_error_code, error_code: entry.error_code, count: entry.count });
  }
  validateCounts(actual, depths, errors, result, stacks, logId, signal);
  return { format_version: 1, capture: { mode: 'dwarf', event: 'cpu-clock', frequency_hz: 99, clock: 'boottime', report_filter: 'disabled', remove_gaps: 0 }, counts: actual, depth_histogram: depths, unwinding_error_histogram: errors,
    architecture: { status: 'unavailable', device_arch: null, target_process_arch: null, reason: architecture.reason }, symbolication: { status: 'reported_symbols_only', build_id_status: 'unavailable', reason: symbolication.reason } };
}

function validateCounts(actual: StackQualityCounts, depths: StackQuality['depth_histogram'], errors: StackQuality['unwinding_error_histogram'], result: ProfileResult, stacks: readonly StackSample[], logId: string | null, signal?: AbortSignal): void {
  const expected: StackQualityCounts = { reported_sample_count: String(stacks.length), parsed_sample_count: String(stacks.length), lost_count: result.lost_count, callchain_frame_count: 0, empty_callchain_sample_count: 0, single_frame_sample_count: 0, max_callchain_depth: 0, unwinding_error_sample_count: 0, unwinding_without_error_sample_count: 0, unwinding_metadata_missing_sample_count: 0, missing_symbol_frame_count: 0, missing_symbol_sample_count: 0 };
  let total = 0; let empty = 0; let single = 0; let maximum = 0; let unwindErrors = 0; let withoutError = 0; let metadataMissing = 0; let symbolFrames = 0; let symbolSamples = 0;
  const depthCounts = new Map<number, number>(); const errorCounts = new Map<string, number>();
  for (const sample of stacks) {
    checkArchiveCancellation(signal, logId);
    const depth = sample.callchain.length; total += depth; empty += Number(depth === 0); single += Number(depth === 1); maximum = Math.max(maximum, depth);
    depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);
    const missing = sample.callchain.filter(frame => frame.symbol === null || frame.symbol.length === 0).length; symbolFrames += missing; symbolSamples += Number(missing > 0);
    if (sample.unwinding === null) { metadataMissing += 1; continue; }
    const raw = sample.unwinding.raw_error_code; const code = sample.unwinding.error_code;
    if (raw !== null && raw !== 0 || code !== null && code !== 0) {
      unwindErrors += 1; const key = JSON.stringify([raw, code]); errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    } else withoutError += 1;
  }
  const computed: StackQualityCounts = { ...expected, callchain_frame_count: total, empty_callchain_sample_count: empty, single_frame_sample_count: single, max_callchain_depth: maximum, unwinding_error_sample_count: unwindErrors, unwinding_without_error_sample_count: withoutError, unwinding_metadata_missing_sample_count: metadataMissing, missing_symbol_frame_count: symbolFrames, missing_symbol_sample_count: symbolSamples };
  if (stacks.length !== result.stack_sample_count || result.reported_sample_count !== undefined && result.reported_sample_count !== computed.reported_sample_count
    || Object.entries(computed).some(([key, count]) => Reflect.get(actual, key) !== count) || depths.length !== depthCounts.size || errors.length !== errorCounts.size
    || depths.some(entry => depthCounts.get(entry.depth) !== entry.count) || errors.some(entry => errorCounts.get(JSON.stringify([entry.raw_error_code, entry.error_code])) !== entry.count)) throw invalidProfile(logId);
}
