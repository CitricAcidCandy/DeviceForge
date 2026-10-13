import { isRecord } from '../../shared/api/validation.ts';
import { decimalU64, onlyKeys } from '../../shared/jobs/index.ts';
import { decodeProfileFrame } from './frame-results.ts';
import { isProfileMetrics } from './metrics.ts';
import { isProfileIdentity } from './results.ts';
import { PROFILE_LIMITS, integer, invalidProfile, nanosecondRange } from './rules.ts';
import type { ProfileIndex, ProfileResult, ProfileSample } from './types.ts';

function decodeSample(value: unknown, identity: ProfileResult, logId: string | null): ProfileSample {
  if (!isRecord(value) || !onlyKeys(value, ['index', 'begin_ns', 'end_ns', 'target_ns', 'metrics', 'frame', 'stack_sample_indices'])
    || !integer(value.index, 0, PROFILE_LIMITS.samples - 1) || !decimalU64(value.begin_ns) || !decimalU64(value.end_ns)
    || !nanosecondRange(value.begin_ns, value.end_ns) || !isProfileMetrics(value.metrics, identity.device_id)
    || value.metrics.pid !== identity.pid || String(value.metrics.process_start_ticks) !== identity.process_start_ticks
    || !Array.isArray(value.stack_sample_indices) || value.stack_sample_indices.length > PROFILE_LIMITS.indicesPerSample) throw invalidProfile(logId);
  let target: string | undefined;
  if (identity.frame_kind === 'scrcpy_sampled_frame') {
    if (!decimalU64(value.target_ns) || BigInt(value.target_ns) !== (BigInt(value.begin_ns) + BigInt(value.end_ns)) / 2n) throw invalidProfile(logId);
    target = value.target_ns;
  } else if (value.target_ns !== undefined) throw invalidProfile(logId);
  const indices: number[] = []; const unique = new Set<number>();
  for (const entry of value.stack_sample_indices) {
    if (!integer(entry, 0, identity.stack_sample_count - 1) || unique.has(entry)) throw invalidProfile(logId);
    indices.push(entry); unique.add(entry);
  }
  return { index: value.index, begin_ns: value.begin_ns, end_ns: value.end_ns, metrics: value.metrics,
    ...(target === undefined ? {} : { target_ns: target }), frame: decodeProfileFrame(value.frame, identity.frame_kind, target, logId), stack_sample_indices: indices };
}
export function decodeProfileIndex(value: unknown, identity: ProfileResult, logId: string | null): ProfileIndex {
  if (!isRecord(value) || !isProfileIdentity(value)
    || !onlyKeys(value, ['format_version', 'device_id', 'package', 'pid', 'process_start_ticks', 'clock', 'frame_kind', 'display_frame_complete', 'root_access', 'stack_status', 'stack_reason', 'frame_status', 'frame_reason', 'samples', 'stack_sample_count', 'lost_count', 'symbolication'])
    || value.device_id !== identity.device_id || value.package !== identity.package || value.pid !== identity.pid
    || value.frame_kind !== identity.frame_kind || value.frame_status !== identity.frame_status || value.frame_reason !== identity.frame_reason
    || value.process_start_ticks !== identity.process_start_ticks || value.root_access !== identity.root_access
    || value.stack_status !== identity.stack_status || value.stack_reason !== identity.stack_reason || value.symbolication !== 'reported_symbols_only'
    || value.stack_status === 'unavailable' && (value.stack_sample_count !== 0 || value.lost_count !== '0')
    || value.stack_sample_count !== identity.stack_sample_count || value.lost_count !== identity.lost_count
    || !Array.isArray(value.samples) || value.samples.length !== identity.sample_count) throw invalidProfile(logId);
  const samples = value.samples.map((sample: unknown) => decodeSample(sample, identity, logId));
  const frames = new Set<number>();
  for (let position = 0; position < samples.length; position += 1) {
    const sample = samples[position]; const previous = samples[position - 1];
    if (!sample || sample.index !== position || previous && BigInt(sample.begin_ns) < BigInt(previous.begin_ns)) throw invalidProfile(logId);
    if (sample.frame) {
      if (frames.has(sample.frame.index) || sample.frame.index !== frames.size) throw invalidProfile(logId);
      frames.add(sample.frame.index);
    }
  }
  if (frames.size !== identity.frame_count) throw invalidProfile(logId);
  return { ...value, samples, stack_sample_count: identity.stack_sample_count, lost_count: identity.lost_count, symbolication: 'reported_symbols_only' };
}
