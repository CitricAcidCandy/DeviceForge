import { decodeArtifactEnvelope, decodeEmptyArtifactResult, invalidBusinessResult, jsonObject, naturalNumber, onlyKeys, requireArtifactNames } from '../../../shared/jobs/index.ts';
import type { PublishedResult } from '../../../shared/jobs/index.ts';
import type { MirroringRecording, MirroringRequest, MirroringStatus } from '../types/index.ts';
import { frozenMirroringCopy, mirroringDeviceId, validMirroringUnicode } from './rules.ts';

export function decodeMirroringStatus(raw: unknown, logId: string | null): MirroringStatus {
  const value = decodeEmptyArtifactResult(raw, '投屏', logId);
  if (!jsonObject(value) || !onlyKeys(value, ['available', 'version', 'live_stream', 'live_configured', 'recording']) || value.available !== true
    || typeof value.version !== 'string' || !validMirroringUnicode(value.version) || value.recording !== true) throw invalidBusinessResult('投屏', logId);
  if (value.live_stream === false && !Object.hasOwn(value, 'live_configured')) return Object.freeze({ available: true, version: value.version, live_stream: false, recording: true });
  if (value.live_stream === true && typeof value.live_configured === 'boolean') return Object.freeze({ available: true, version: value.version, live_stream: true, live_configured: value.live_configured, recording: true });
  throw invalidBusinessResult('投屏', logId);
}
function isRecording(value: unknown): value is MirroringRecording {
  return jsonObject(value) && onlyKeys(value, ['device_id', 'duration_ms', 'codec', 'filename', 'size', 'live_stream']) && mirroringDeviceId(value.device_id)
    && naturalNumber(value.duration_ms) && value.duration_ms >= 1000 && value.duration_ms <= 120000 && value.duration_ms % 1000 === 0
    && value.codec === 'h264' && value.filename === 'screen.mp4' && naturalNumber(value.size) && value.size >= 12 && value.size <= 128 * 1024 * 1024 && value.live_stream === false;
}
export function decodeMirroringDownload(raw: unknown, logId: string | null): PublishedResult<MirroringRecording> {
  const envelope = decodeArtifactEnvelope(raw, '投屏', logId); requireArtifactNames(envelope, ['screen.mp4'], '投屏', logId);
  const value = envelope.result;
  if (!isRecording(value) || envelope.artifacts[0]?.size !== value.size) throw invalidBusinessResult('投屏', logId);
  return frozenMirroringCopy({ result: value, artifacts: envelope.artifacts });
}
export function decodeMirroringRecording(raw: unknown, logId: string | null, input: MirroringRequest): PublishedResult<MirroringRecording> {
  const output = decodeMirroringDownload(raw, logId);
  if (output.result.device_id !== input.device_id || output.result.duration_ms !== Math.ceil(input.duration_ms / 1000) * 1000) throw invalidBusinessResult('投屏', logId);
  return output;
}
