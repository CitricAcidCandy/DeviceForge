import { ApiError } from '../../shared/api/index.ts';
import type { MirroringAudioConfig } from './types.ts';

export interface MirroringAudioOptions {
  readonly context: AudioContext;
  readonly destination?: AudioNode;
  readonly maxLeadSeconds?: number;
}
export function decodeMirroringPcm(bytes: Uint8Array): readonly [Float32Array, Float32Array] {
  if (bytes.byteLength < 4 || bytes.byteLength % 4 !== 0 || bytes.byteLength > 4 * 1024 * 1024) throw new ApiError('protocol', 'invalid_mirroring_pcm', 'PCM 音频须为对齐的 16 位双声道字节');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const left = new Float32Array(bytes.byteLength / 4); const right = new Float32Array(left.length);
  for (let index = 0; index < left.length; ++index) { left[index] = view.getInt16(index * 4, true) / 32768; right[index] = view.getInt16(index * 4 + 2, true) / 32768; }
  return Object.freeze([left, right]);
}
export function createMirroringAudioPlayer(options: MirroringAudioOptions) {
  const context = options.context; const destination = options.destination ?? context.destination;
  const maxLead = options.maxLeadSeconds ?? 0.2;
  if (!Number.isFinite(maxLead) || maxLead < 0.02 || maxLead > 1) throw new ApiError('protocol', 'invalid_mirroring_audio_limit', '音频预排时长须为 0.02 至 1 秒');
  const sources = new Map<AudioBufferSourceNode, () => void>();
  let configuration: MirroringAudioConfig | null = null; let nextTime = 0; let closed = false;
  function assertOpen(): void { if (closed) throw new ApiError('cancelled', 'mirroring_audio_closed', '音频播放器已关闭'); }
  function clear(): void {
    for (const [source, release] of sources) { release(); try { source.stop(); } catch { } }
    sources.clear(); nextTime = 0;
  }
  return {
    configure(value: MirroringAudioConfig) {
      assertOpen();
      if (value.codec !== 'pcm_s16le' || value.sample_rate !== 48000 || value.channels !== 2) throw new ApiError('protocol', 'invalid_mirroring_audio_config', '音频配置须为 48kHz 的 PCM16 双声道');
      clear(); configuration = Object.freeze({ ...value });
    },
    push(bytes: Uint8Array, signal: AbortSignal): boolean {
      assertOpen();
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '音频交付已取消');
      if (!configuration) throw new ApiError('protocol', 'mirroring_audio_not_configured', '音频块到达前须配置播放器');
      const [left, right] = decodeMirroringPcm(bytes);
      // 音频上下文的启动由实际宿主在用户交互时完成，不自动绕过浏览器播放规则。
      if (context.state !== 'running') return false;
      const duration = left.length / configuration.sample_rate;
      if (duration > maxLead) return false;
      if (sources.size >= 32 || nextTime - context.currentTime + duration > maxLead) clear();
      const buffer = context.createBuffer(2, left.length, configuration.sample_rate);
      buffer.getChannelData(0).set(left); buffer.getChannelData(1).set(right);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
      const release = () => { signal.removeEventListener('abort', cancelled); source.onended = null; sources.delete(source); source.disconnect(); };
      const cancelled = () => { release(); try { source.stop(); } catch { } if (sources.size === 0) nextTime = 0; };
      sources.set(source, release); source.onended = release; signal.addEventListener('abort', cancelled, { once: true });
      const start = Math.max(nextTime, context.currentTime);
      try { source.start(start); nextTime = start + duration; return true; }
      catch (error) { release(); throw error; }
    },
    reset() { assertOpen(); clear(); configuration = null; },
    snapshot: () => Object.freeze({ configured: configuration !== null, scheduled: sources.size, contextState: context.state }),
    dispose() { if (closed) return; closed = true; clear(); configuration = null; },
  };
}
