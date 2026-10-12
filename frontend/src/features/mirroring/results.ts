import { isRecord } from '../../shared/api/validation.ts';
import { decodeArtifactEnvelope, decodeEmptyArtifactResult, invalidBusinessResult, naturalNumber, requireArtifactNames } from '../../shared/jobs/index.ts';
import type { PublishedResult } from '../../shared/jobs/index.ts';
import type { MirroringRecording, MirroringRequest, MirroringStatus } from './types.ts';

export function decodeMirroringStatus(raw: unknown, logId: string | null): MirroringStatus {
  const value = decodeEmptyArtifactResult(raw, '投屏', logId);
  if (!isRecord(value) || value.available !== true || typeof value.version !== 'string' || value.live_stream !== false || value.recording !== true) throw invalidBusinessResult('投屏', logId);
  return { available: true, version: value.version, live_stream: false, recording: true };
}
export function decodeMirroringRecording(raw: unknown, logId: string | null, input: MirroringRequest): PublishedResult<MirroringRecording> {
  const envelope = decodeArtifactEnvelope(raw, '投屏', logId); requireArtifactNames(envelope, ['screen.mp4'], '投屏', logId);
  const value = envelope.result;
  if (!isRecord(value) || value.device_id !== input.device_id || value.duration_ms !== Math.ceil(input.duration_ms / 1000) * 1000
    || value.codec !== 'h264' || value.filename !== 'screen.mp4' || !naturalNumber(value.size) || value.size < 12 || value.size > 128 * 1024 * 1024 || value.live_stream !== false
    || envelope.artifacts[0]?.size !== value.size) throw invalidBusinessResult('投屏', logId);
  return { result: { device_id: input.device_id, duration_ms: value.duration_ms, codec: 'h264', filename: 'screen.mp4', size: value.size, live_stream: false }, artifacts: envelope.artifacts };
}
