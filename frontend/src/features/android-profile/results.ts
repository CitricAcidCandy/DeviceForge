import { isRecord } from '../../shared/api/validation.ts';
import { decimalU64, decodeArtifactEnvelope, onlyKeys, requireArtifactNames } from '../../shared/jobs/index.ts';
import type { PublishedResult } from '../../shared/jobs/index.ts';
import { PROFILE_LIMITS, deviceId, boundedText, integer, invalidProfile, nullableText, packageName } from './rules.ts';
import type { ProbeResult, ProfileIdentity, ProfileResult } from './types.ts';

function validFrameStatus(value: Record<string, unknown>): boolean {
  if (value.frame_status === undefined && value.frame_reason === undefined) return value.frame_kind === 'sampled_screenshot';
  return value.frame_status === 'captured' && value.frame_reason === null
    || value.frame_status === 'unavailable' && boundedText(value.frame_reason) && value.frame_reason.length > 0
    || value.frame_status === 'disabled' && nullableText(value.frame_reason);
}
export function isProfileIdentity(value: unknown): value is ProfileIdentity {
  return isRecord(value) && value.format_version === 1 && deviceId(value.device_id) && packageName(value.package)
    && integer(value.pid, 1, 4294967295) && decimalU64(value.process_start_ticks) && value.clock === 'boottime'
    && (value.frame_kind === 'sampled_screenshot' || value.frame_kind === 'scrcpy_sampled_frame') && value.display_frame_complete === false && validFrameStatus(value)
    && (value.root_access === 'none' || value.root_access === 'adbd_root' || value.root_access === 'su')
    && (value.stack_status === 'captured' && value.root_access !== 'none' && value.stack_reason === null
      || value.stack_status === 'unavailable' && boundedText(value.stack_reason) && value.stack_reason.length > 0);
}
export function decodeProbe(value: unknown, logId: string | null, device: string, packageId: string): ProbeResult {
  const envelope = decodeArtifactEnvelope(value, 'Android 堆栈资格', logId);
  const result = envelope.result;
  if (envelope.artifacts.length !== 0 || !isRecord(result)
    || !onlyKeys(result, ['format_version', 'device_id', 'package', 'root_access', 'simpleperf_available', 'clock', 'supported', 'reason'])
    || result.format_version !== 1 || result.device_id !== device || result.package !== packageId || result.clock !== 'boottime'
    || !(result.root_access === 'none' || result.root_access === 'adbd_root' || result.root_access === 'su') || typeof result.simpleperf_available !== 'boolean' || typeof result.supported !== 'boolean'
    || result.supported !== (result.root_access !== 'none' && result.simpleperf_available) || !nullableText(result.reason, 4096)) throw invalidProfile(logId);
  return { format_version: 1, device_id: device, package: packageId, root_access: result.root_access,
    simpleperf_available: result.simpleperf_available, clock: 'boottime', supported: result.supported, reason: result.reason };
}
export function decodeProfileResult(value: unknown, logId: string | null, device: string, packageId: string): PublishedResult<ProfileResult> {
  const envelope = decodeArtifactEnvelope(value, 'Android 堆栈录制', logId);
  const result = envelope.result;
  if (!isRecord(result) || !isProfileIdentity(result)
    || !onlyKeys(result, ['format_version', 'device_id', 'package', 'pid', 'process_start_ticks', 'clock', 'frame_kind', 'display_frame_complete', 'root_access', 'stack_status', 'stack_reason', 'frame_status', 'frame_reason', 'sample_count', 'stack_sample_count', 'lost_count', 'reported_sample_count', 'frame_count', 'index_filename', 'archive_filename'])
    || result.device_id !== device || result.package !== packageId || !integer(result.sample_count, 1, PROFILE_LIMITS.samples)
    || !integer(result.stack_sample_count, 0, PROFILE_LIMITS.stacks) || !decimalU64(result.lost_count)
    || !(result.reported_sample_count === undefined || decimalU64(result.reported_sample_count))
    || result.stack_status === 'unavailable' && (result.stack_sample_count !== 0 || result.lost_count !== '0' || result.reported_sample_count !== undefined && result.reported_sample_count !== '0')
    || !integer(result.frame_count, 0, result.sample_count)
    || result.frame_status === 'captured' && result.frame_count === 0
    || (result.frame_status === 'unavailable' || result.frame_status === 'disabled') && result.frame_count !== 0 || result.index_filename !== 'profile-index.json' || result.archive_filename !== 'profile.zip') throw invalidProfile(logId);
  requireArtifactNames(envelope, ['profile-index.json', 'profile.zip'], 'Android 堆栈录制', logId);
  for (const artifact of envelope.artifacts) {
    const index = artifact.filename === 'profile-index.json';
    if (artifact.size === 0 || artifact.size > (index ? PROFILE_LIMITS.indexBytes : PROFILE_LIMITS.archiveBytes)
      || artifact.media_type !== (index ? 'application/json' : 'application/zip')) throw invalidProfile(logId);
  }
  return { result: { ...result, sample_count: result.sample_count, stack_sample_count: result.stack_sample_count,
    lost_count: result.lost_count, ...(result.reported_sample_count === undefined ? {} : { reported_sample_count: result.reported_sample_count }), frame_count: result.frame_count, index_filename: result.index_filename, archive_filename: result.archive_filename }, artifacts: envelope.artifacts };
}
