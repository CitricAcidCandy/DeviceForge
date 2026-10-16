import { ApiError, isSessionInfo, isSessionOutputPage, normalizeSessionId } from '../../../services/api/index.ts';
import type { SessionInfo, SessionOutputPage } from '../../../services/api/index.ts';
import { normalizeMirroringControl } from '../utils/rules.ts';
import type { MirroringControl } from '../types/index.ts';

export const WEBRTC_OPEN = 'plugin.mirroring.open_webrtc';
const encoder = new TextEncoder();

export type WebRtcSignal =
  | { readonly type: 'offer'; readonly sdp: string }
  | { readonly type: 'status'; readonly state: 'connecting' | 'streaming' | 'audio_unavailable' };

function invalid(message: string, logId: string | null = null): ApiError {
  return new ApiError('protocol', 'mirroring_webrtc_protocol', message, null, logId);
}

export function decodeWebRtcSession(value: unknown, logId: string | null, identity?: SessionInfo): SessionInfo {
  if (!isSessionInfo(value) || value.operation !== WEBRTC_OPEN || value.plugin_id !== 'mirroring')
    throw invalid('WebRTC 投屏会话身份无效', logId);
  const id = normalizeSessionId(value.id);
  if (identity && (id !== identity.id || value.generation !== identity.generation ||
    value.created_at !== identity.created_at || value.operation !== identity.operation))
    throw invalid('WebRTC 投屏会话代次不一致', logId);
  return { ...value, id };
}

export function decodeWebRtcPage(value: unknown, identity: SessionInfo, after: number, limit: number,
  logId: string | null): SessionOutputPage {
  if (!isSessionOutputPage(value)) throw invalid('WebRTC 信令输出页无效', logId);
  const session = decodeWebRtcSession(value.session, logId, identity);
  const expected = Math.min(limit, session.output_sequence - after);
  if (expected < 0 || value.chunks.length !== expected || value.next_sequence !== after + expected ||
    value.chunks.some((chunk, index) => chunk.sequence !== after + index + 1 || chunk.stream !== 'stdout'))
    throw invalid('WebRTC 信令输出缺块或顺序错误', logId);
  return { ...value, session };
}

export function createWebRtcSignalDecoder() {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '';
  let bytes = 0;
  return {
    push(chunk: readonly number[]): WebRtcSignal[] {
      const output: WebRtcSignal[] = [];
      for (const byte of chunk) {
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw invalid('WebRTC 信令字节无效');
        if (++bytes > 65536) throw invalid('WebRTC 信令单行超过 65536 字节');
        let decoded: string;
        try { decoded = decoder.decode(Uint8Array.of(byte), { stream: true }); }
        catch { throw invalid('WebRTC 信令 UTF-8 无效'); }
        line += decoded;
        if (byte !== 10) continue;
        let message: unknown;
        try { message = JSON.parse(line); }
        catch { throw invalid('WebRTC 信令 JSON 无效'); }
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw invalid('WebRTC 信令结构无效');
        const record: Record<string, unknown> = Object.fromEntries(Object.entries(message));
        if (record.version !== 1 || record.epoch !== 1) throw invalid('WebRTC 信令版本或代次无效');
        if (record.type === 'offer' && typeof record.sdp === 'string' && record.sdp.length > 0 &&
          Object.keys(record).every((key) => ['version', 'epoch', 'type', 'sdp'].includes(key)))
          output.push({ type: 'offer', sdp: record.sdp });
        else if (record.type === 'status' &&
          (record.state === 'connecting' || record.state === 'streaming' || record.state === 'audio_unavailable') &&
          Object.keys(record).every((key) => ['version', 'epoch', 'type', 'state'].includes(key)))
          output.push({ type: 'status', state: record.state });
        else throw invalid('WebRTC 信令类型或字段无效');
        line = '';
        bytes = 0;
      }
      return output;
    },
    finish() {
      if (bytes) throw invalid('WebRTC 信令末行不完整');
    },
  };
}

export function encodeWebRtcAnswer(sdp: string): readonly number[] {
  if (!sdp) throw invalid('WebRTC answer 为空');
  const bytes = encoder.encode(`${JSON.stringify({ version: 1, epoch: 1, type: 'answer', sdp })}\n`);
  if (bytes.length > 65536) throw invalid('WebRTC answer 超出单行边界');
  return [...bytes];
}

export function encodeWebRtcControl(command: MirroringControl, epoch: 1 = 1, controlRevision?: number): readonly number[] {
  if (epoch !== 1 || (controlRevision !== undefined &&
    (!Number.isSafeInteger(controlRevision) || controlRevision < 1)))
    throw invalid('WebRTC 控制代次或所有权修订无效');
  const normalized = normalizeMirroringControl(command);
  const bytes = encoder.encode(`${JSON.stringify({ version: 1, epoch, type: 'control', command: normalized,
    ...(controlRevision === undefined ? {} : { control_revision: controlRevision }),
  })}\n`);
  if (bytes.length > 4096) throw invalid('WebRTC 控制超过 4096 字节');
  return [...bytes];
}
