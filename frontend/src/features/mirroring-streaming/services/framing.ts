import { invalidStream } from '../utils/errors.ts';
export { invalidStream } from '../utils/errors.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';
import type { MirroringPacket } from '../types/index.ts';
import { isDeviceClipboardText } from '../utils/rules.ts';
export const MIRRORING_HEADER_SIZE = 24;
export const MIRRORING_MAX_PAYLOAD = 4 * 1024 * 1024;
function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalidStream('投屏配置或状态不是有效 UTF-8 JSON');
  }
}
function packet(header: Uint8Array, bytes: Uint8Array): MirroringPacket {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const timestamp = view.getBigUint64(8);
  if (timestamp > BigInt(Number.MAX_SAFE_INTEGER))
    throw invalidStream('投屏时间戳超出浏览器安全整数');
  const identity = { epoch: view.getUint32(20), timestampUs: Number(timestamp) };
  const kind = header[5];
  const flags = view.getUint16(6);
  if (kind === 2)
    return Object.freeze({
      ...identity,
      kind: 'video',
      keyFrame: flags === 1,
      configuration: flags === 2,
      bytes,
    });
  if (kind === 4) return Object.freeze({ ...identity, kind: 'audio', bytes });
  const value = json(bytes);
  if (!jsonObject(value)) throw invalidStream('投屏配置或状态须为 JSON 对象');
  if (kind === 6 && onlyKeys(value, ['text']) && isDeviceClipboardText(value.text))
    return Object.freeze({ ...identity, kind: 'clipboard', text: value.text });
  if (
    kind === 1 &&
    onlyKeys(value, ['codec', 'format', 'width', 'height']) &&
    value.codec === 'h264' &&
    value.format === 'annexb' &&
    naturalNumber(value.width) &&
    value.width >= 1 &&
    value.width <= 8192 &&
    naturalNumber(value.height) &&
    value.height >= 1 &&
    value.height <= 8192
  ) {
    return Object.freeze({
      ...identity,
      kind: 'video_config',
      configuration: Object.freeze({
        codec: 'h264',
        format: 'annexb',
        width: value.width,
        height: value.height,
      }),
    });
  }
  if (
    kind === 3 &&
    onlyKeys(value, ['codec', 'sample_rate', 'channels']) &&
    value.codec === 'pcm_s16le' &&
    value.sample_rate === 48000 &&
    value.channels === 2
  ) {
    return Object.freeze({
      ...identity,
      kind: 'audio_config',
      configuration: Object.freeze({ codec: 'pcm_s16le', sample_rate: 48000, channels: 2 }),
    });
  }
  if (
    kind === 5 &&
    onlyKeys(value, ['state', 'attempt']) &&
    (value.state === 'connecting' ||
      value.state === 'streaming' ||
      value.state === 'reconnecting' ||
      value.state === 'audio_unavailable') &&
    naturalNumber(value.attempt) &&
    value.attempt <= 5
  )
    return Object.freeze({
      ...identity,
      kind: 'status',
      status: Object.freeze({ state: value.state, attempt: value.attempt }),
    });
  throw invalidStream('投屏配置或状态与版本 1 合同不匹配');
}
export function createMirroringFramer() {
  const header = new Uint8Array(MIRRORING_HEADER_SIZE);
  let headerSize = 0;
  let payload: Uint8Array | null = null;
  let payloadSize = 0;
  function reset(): void {
    headerSize = 0;
    payload = null;
    payloadSize = 0;
  }
  return {
    push(bytes: readonly number[]): readonly MirroringPacket[] {
      if (
        bytes.length > 8192 ||
        bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
      )
        throw invalidStream('投屏输出块须为最多 8192 个原字节');
      const packets: MirroringPacket[] = [];
      let offset = 0;
      try {
        while (offset < bytes.length) {
          if (headerSize < MIRRORING_HEADER_SIZE) {
            const count = Math.min(MIRRORING_HEADER_SIZE - headerSize, bytes.length - offset);
            header.set(bytes.slice(offset, offset + count), headerSize);
            headerSize += count;
            offset += count;
            if (headerSize < MIRRORING_HEADER_SIZE) break;
            const view = new DataView(header.buffer);
            const kind = header[5];
            const flags = view.getUint16(6);
            const length = view.getUint32(16);
            if (
              header[0] !== 68 ||
              header[1] !== 70 ||
              header[2] !== 77 ||
              header[3] !== 76 ||
              header[4] !== 1 ||
              kind === undefined ||
              kind < 1 ||
              kind > 6 ||
              (kind === 2 ? flags > 2 : flags !== 0) ||
              view.getUint32(20) === 0 ||
              length < 1 ||
              length > MIRRORING_MAX_PAYLOAD ||
              (kind === 6 && length > 1572864)
            )
              throw invalidStream('投屏二进制包头、版本、标记或大小无效');
            payload = new Uint8Array(length);
          }
          if (!payload) throw invalidStream('投屏载荷缓冲状态无效');
          const count = Math.min(payload.length - payloadSize, bytes.length - offset);
          payload.set(bytes.slice(offset, offset + count), payloadSize);
          payloadSize += count;
          offset += count;
          if (payloadSize === payload.length) {
            packets.push(packet(header, payload));
            reset();
          }
        }
      } catch (error) {
        reset();
        throw error;
      }
      return Object.freeze(packets);
    },
    pendingBytes: () => headerSize + payloadSize,
    finish() {
      if (headerSize !== 0 || payload !== null)
        throw invalidStream('投屏会话结束时仍有截断二进制包');
    },
    reset,
  };
}
