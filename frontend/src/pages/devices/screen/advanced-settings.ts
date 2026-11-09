import type { MirroringStreamInput } from '../../../features/mirroring-streaming/index.ts';

/** 草稿保留用户原输入，只有显式开始时才转换为原投屏参数。 */
export interface AdvancedMirroringDraft {
  readonly videoBitRateMbps: string;
  readonly audio: boolean;
  readonly clipboardAutosync: boolean;
  readonly reconnectAttempts: string;
}

export type AdvancedMirroringErrors = Partial<Record<'videoBitRateMbps' | 'reconnectAttempts', string>>;
type AdvancedMirroringInput = Pick<MirroringStreamInput, 'video_bit_rate' | 'reconnect_attempts'> &
  Required<Pick<MirroringStreamInput, 'audio' | 'clipboard_autosync'>>;

export function defaultAdvancedMirroringSettings(): AdvancedMirroringDraft {
  return { videoBitRateMbps: '', audio: false, clipboardAutosync: true, reconnectAttempts: '0' };
}

function videoBitRate(value: string): number | undefined | null {
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > 64 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const [whole = '', rawFraction = ''] = text.split('.');
  const fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length > 6) return null;
  // 按十进制位拆分换算，避免浮点乘法把一位有效 bit/s 变成小数。
  const result = Number(whole || '0') * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(result) && result >= 128_000 && result <= 16_000_000 ? result : null;
}

export function resolveAdvancedMirroringSettings(
  draft: AdvancedMirroringDraft,
  options: { readonly control: boolean; readonly webRtc: boolean },
): { readonly input: AdvancedMirroringInput | null; readonly errors: AdvancedMirroringErrors } {
  const errors: AdvancedMirroringErrors = {};
  const bitRate = videoBitRate(draft.videoBitRateMbps);
  if (bitRate === null) errors.videoBitRateMbps = '请输入 0.128–16 Mbps，最多保留6位小数';
  // WebRTC 的固定0不清掉兼容通道草稿，也不能把该草稿带入 WebRTC 请求。
  const reconnectText = draft.reconnectAttempts.trim();
  const reconnect = options.webRtc ? 0 : Number(reconnectText);
  if (!options.webRtc && (!/^\d+$/.test(reconnectText) || !Number.isInteger(reconnect) || reconnect > 5))
    errors.reconnectAttempts = '请输入0–5的整数';
  if (Object.keys(errors).length !== 0) return { input: null, errors };
  return {
    input: {
      audio: draft.audio,
      clipboard_autosync: options.control && draft.clipboardAutosync,
      ...(typeof bitRate === 'number' ? { video_bit_rate: bitRate } : {}),
      ...(reconnect > 0 ? { reconnect_attempts: reconnect } : {}),
    },
    errors,
  };
}
