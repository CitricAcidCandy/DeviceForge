import { isRecord } from '../../shared/api/validation.ts';
import { decimalU64, onlyKeys } from '../../shared/jobs/index.ts';
import { PROFILE_LIMITS, integer, invalidProfile, nanosecondRange } from './rules.ts';
import type { ProfileFrame, ProfileIdentity } from './types.ts';

export function decodeProfileFrame(value: unknown, kind: ProfileIdentity['frame_kind'], target: string | undefined, logId: string | null): ProfileFrame | null {
  if (value === null) return null;
  if (!isRecord(value) || !integer(value.index, 0, PROFILE_LIMITS.samples - 1) || typeof value.filename !== 'string'
    || value.filename !== 'frames/' + String(value.index).padStart(6, '0') + '.png'
    || !decimalU64(value.begin_ns) || !decimalU64(value.end_ns) || !nanosecondRange(value.begin_ns, value.end_ns)) throw invalidProfile(logId);
  const base = { index: value.index, filename: value.filename, begin_ns: value.begin_ns, end_ns: value.end_ns };
  if (kind === 'sampled_screenshot') {
    if (!onlyKeys(value, ['index', 'filename', 'begin_ns', 'end_ns'])) throw invalidProfile(logId);
    return base;
  }
  if (!onlyKeys(value, ['index', 'filename', 'begin_ns', 'end_ns', 'source', 'epoch', 'video_frame_index', 'pts_us', 'device_time_ns', 'selection_delta_ns', 'clock_error_ns'])
    || value.source !== 'scrcpy' || value.epoch !== 1 || !integer(value.video_frame_index, 0, 4294967295)
    || !decimalU64(value.pts_us) || !decimalU64(value.device_time_ns) || !decimalU64(value.clock_error_ns)
    || typeof value.selection_delta_ns !== 'string' || !/^(?:0|-?[1-9][0-9]{0,19})$/.test(value.selection_delta_ns) || target === undefined) throw invalidProfile(logId);
  const time = BigInt(value.device_time_ns); const error = BigInt(value.clock_error_ns); const delta = BigInt(value.selection_delta_ns);
  if (error > 20000000n || delta < -250000000n || delta > 250000000n || time - BigInt(target) !== delta
    || BigInt(value.begin_ns) !== (time > error ? time - error : 0n) || BigInt(value.end_ns) !== time + error) throw invalidProfile(logId);
  return { ...base, source: 'scrcpy', epoch: 1, video_frame_index: value.video_frame_index, pts_us: value.pts_us,
    device_time_ns: value.device_time_ns, selection_delta_ns: value.selection_delta_ns, clock_error_ns: value.clock_error_ns };
}
