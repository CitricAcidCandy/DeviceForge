import { ApiError } from '../../../shared/api/index.ts';
import { abortable } from '../../../shared/api/abort.ts';

export interface MirroringVideoConfiguration {
  readonly codec: string;
  readonly codedWidth: number;
  readonly codedHeight: number;
}
export interface MirroringVideoPacket {
  readonly keyFrame: boolean;
  readonly timestampUs: number;
  readonly bytes: Uint8Array;
}
export interface MirroringVideoDecoder {
  readonly decodeQueueSize: number;
  configure(configuration: VideoDecoderConfig): void;
  decode(packet: MirroringVideoPacket): void;
  reset(): void;
  close(): void;
}
export interface MirroringVideoEnvironment {
  supported(configuration: VideoDecoderConfig): Promise<boolean>;
  create(output: (frame: VideoFrame) => void, error: (error: Error) => void): MirroringVideoDecoder;
}
export interface MirroringVideoOptions {
  readonly output: (frame: VideoFrame) => void;
  readonly error?: (error: ApiError) => void;
  readonly environment?: MirroringVideoEnvironment;
  readonly maxDecodeQueue?: number;
}
function nativeEnvironment(): MirroringVideoEnvironment {
  return {
    async supported(configuration) {
      if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return false;
      return (await VideoDecoder.isConfigSupported(configuration)).supported === true;
    },
    create(output, error) {
      const decoder = new VideoDecoder({ output, error });
      return {
        get decodeQueueSize() { return decoder.decodeQueueSize; },
        configure: (configuration) => decoder.configure(configuration),
        decode: (packet) => decoder.decode(new EncodedVideoChunk({ type: packet.keyFrame ? 'key' : 'delta', timestamp: packet.timestampUs, data: packet.bytes })),
        reset: () => decoder.reset(),
        close: () => { if (decoder.state !== 'closed') decoder.close(); },
      };
    },
  };
}
function configuration(value: MirroringVideoConfiguration): VideoDecoderConfig {
  if (!/^avc1\.[0-9a-f]{6}$/i.test(value.codec) || !Number.isInteger(value.codedWidth) || value.codedWidth < 1 || value.codedWidth > 8192
    || !Number.isInteger(value.codedHeight) || value.codedHeight < 1 || value.codedHeight > 8192) throw new ApiError('protocol', 'invalid_mirroring_video_config', '视频解码配置须为 H264 与有效画面尺寸');
  return Object.freeze({ ...value, optimizeForLatency: true });
}
export function createMirroringVideoDecoder(options: MirroringVideoOptions) {
  const environment = options.environment ?? nativeEnvironment();
  const maxQueue = options.maxDecodeQueue ?? 4;
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 32) throw new ApiError('protocol', 'invalid_mirroring_decode_limit', '视频解码队列限额须为 1 至 32');
  const lifetime = new AbortController();
  let decoder: MirroringVideoDecoder | null = null;
  let selected: VideoDecoderConfig | null = null;
  let epoch = 0;
  let waitingKey = true;
  let closed = false;
  let failure: ApiError | null = null;
  let releaseSignal: () => void = () => {};
  function assertOpen(): void {
    if (closed) throw new ApiError('cancelled', 'mirroring_decoder_closed', '视频解码器已关闭');
    if (failure) throw failure;
  }
  function clear(): void {
    releaseSignal(); releaseSignal = () => {};
    const previous = decoder; decoder = null; selected = null; waitingKey = true;
    previous?.close();
  }
  return {
    async configure(value: MirroringVideoConfiguration, signal: AbortSignal): Promise<void> {
      if (closed || signal.aborted) throw new ApiError('cancelled', 'mirroring_decoder_closed', '视频解码配置已取消或关闭');
      const admitted = ++epoch; clear(); failure = null;
      const requested = configuration(value);
      const active = AbortSignal.any([signal, lifetime.signal]);
      const supported = await abortable(environment.supported(requested), active);
      if (admitted !== epoch) throw new ApiError('cancelled', 'stale_mirroring_decoder', '视频配置已被新代替换');
      if (active.aborted) throw new ApiError('cancelled', 'cancelled', '视频解码配置已取消');
      assertOpen();
      if (!supported) throw new ApiError('protocol', 'mirroring_video_unsupported', '当前浏览器不支持此 H264 解码配置');
      selected = requested;
      decoder = environment.create((frame) => {
        try { if (!closed && !active.aborted && admitted === epoch && !failure) options.output(frame); }
        finally { frame.close(); }
      }, (error) => {
        if (closed || admitted !== epoch) return;
        failure = new ApiError('protocol', 'mirroring_video_decode_failed', error.message);
        waitingKey = true;
        options.error?.(failure);
      });
      decoder.configure(requested);
      const cancelled = () => { if (admitted !== epoch) return; ++epoch; clear(); };
      active.addEventListener('abort', cancelled, { once: true });
      releaseSignal = () => { active.removeEventListener('abort', cancelled); };
    },
    push(packet: MirroringVideoPacket): boolean {
      assertOpen();
      if (!decoder || !selected) throw new ApiError('protocol', 'mirroring_video_not_configured', '视频帧到达前须配置解码器');
      if (!Number.isSafeInteger(packet.timestampUs) || packet.timestampUs < 0 || packet.bytes.length < 1 || packet.bytes.length > 4 * 1024 * 1024) throw new ApiError('protocol', 'invalid_mirroring_video_packet', '视频时间戳或帧大小无效');
      if (decoder.decodeQueueSize >= maxQueue) {
        // 丢弃未解码依赖链后，必须等待下一关键帧，不能继续显示破损差分帧。
        decoder.reset(); decoder.configure(selected); waitingKey = true;
      }
      if (waitingKey && !packet.keyFrame) return false;
      decoder.decode({ ...packet, bytes: packet.bytes.slice() });
      waitingKey = false;
      return true;
    },
    reset() { if (closed) throw new ApiError('cancelled', 'mirroring_decoder_closed', '视频解码器已关闭'); ++epoch; clear(); failure = null; },
    snapshot: () => Object.freeze({ configured: decoder !== null, waitingKeyFrame: waitingKey, decodeQueueSize: decoder?.decodeQueueSize ?? 0, error: failure }),
    dispose() { if (closed) return; closed = true; ++epoch; lifetime.abort(); clear(); },
  };
}
