import { ApiError } from '../../../services/api/index.ts';
import { createMirroringVideoDecoder } from './video.ts';
import type { MirroringVideoEnvironment } from './video.ts';
import { createMirroringAudioPlayer } from './audio.ts';
import { mirroringH264Codec, prependMirroringH264Configuration } from './h264.ts';
import type { MirroringPacket, MirroringStreamSink, MirroringVideoConfig } from '../types/index.ts';

export interface BrowserMirroringSinkOptions {
  readonly videoOutput: (frame: VideoFrame) => void;
  readonly videoEnvironment?: MirroringVideoEnvironment;
  readonly error?: (error: ApiError) => void;
  readonly audioContext?: AudioContext;
  readonly audioDestination?: AudioNode;
}
export function createBrowserMirroringSink(options: BrowserMirroringSinkOptions): MirroringStreamSink {
  const video = createMirroringVideoDecoder({ output: options.videoOutput, ...(options.videoEnvironment ? { environment: options.videoEnvironment } : {}), ...(options.error ? { error: options.error } : {}) });
  const audio = options.audioContext ? createMirroringAudioPlayer({ context: options.audioContext, ...(options.audioDestination ? { destination: options.audioDestination } : {}) }) : null;
  let configuration: MirroringVideoConfig | null = null; let codecBytes: Uint8Array | null = null; let epoch = 0; let closed = false;
  function reset(): void { configuration = null; codecBytes = null; epoch = 0; video.reset(); audio?.reset(); }
  return {
    async packet(packet: MirroringPacket, signal: AbortSignal): Promise<void> {
      if (closed || signal.aborted) throw new ApiError('cancelled', 'mirroring_sink_closed', '投屏解码交付已取消');
      if (packet.epoch !== epoch) { reset(); epoch = packet.epoch; }
      if (packet.kind === 'video_config') { configuration = packet.configuration; codecBytes = null; video.reset(); }
      else if (packet.kind === 'video') {
        if (!configuration) throw new ApiError('protocol', 'mirroring_video_not_configured', '视频缺少当前代次画面配置');
        if (packet.configuration) {
          codecBytes = packet.bytes.slice();
          await video.configure({ codec: mirroringH264Codec(codecBytes), codedWidth: configuration.width, codedHeight: configuration.height }, signal);
        } else {
          if (!codecBytes) throw new ApiError('protocol', 'mirroring_video_not_configured', '视频缺少当前代次 SPS/PPS');
          if (!video.snapshot().configured) await video.configure({ codec: mirroringH264Codec(codecBytes), codedWidth: configuration.width, codedHeight: configuration.height }, signal);
          const bytes = packet.keyFrame ? prependMirroringH264Configuration(codecBytes, packet.bytes) : packet.bytes;
          video.push({ keyFrame: packet.keyFrame, timestampUs: packet.timestampUs, bytes });
        }
      } else if (packet.kind === 'audio_config') audio?.configure(packet.configuration);
      else if (packet.kind === 'audio') audio?.push(packet.bytes, signal);
      else if (packet.kind === 'status' && packet.status.state === 'audio_unavailable') audio?.reset();
    },
    reset,
    dispose() { if (closed) return; closed = true; configuration = null; codecBytes = null; video.dispose(); audio?.dispose(); },
  };
}
