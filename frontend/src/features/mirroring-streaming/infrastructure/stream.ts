import type { MirroringPacket } from '../domain/types.ts';
import { createMirroringFramer, invalidStream } from './framing.ts';

export function createMirroringStream() {
  const framer = createMirroringFramer();
  let epoch = 0; let packets = 0; let video = false; let videoConfig = false; let audio = false;
  return {
    push(bytes: readonly number[]): readonly MirroringPacket[] {
      const decoded = framer.push(bytes);
      for (const packet of decoded) {
        if (packet.epoch < epoch) throw invalidStream('投屏重连代次回退');
        if (packet.epoch > epoch) {
          if (packet.kind !== 'status' && packet.kind !== 'video_config') throw invalidStream('投屏新代必须从状态或画面配置开始');
          epoch = packet.epoch; video = false; videoConfig = false; audio = false;
        }
        if (packet.kind === 'video_config') { video = true; videoConfig = false; }
        else if (packet.kind === 'video') {
          if (!video || !packet.configuration && !videoConfig) throw invalidStream('投屏视频缺少本代画面与 SPS/PPS 配置');
          if (packet.configuration) videoConfig = true;
        } else if (packet.kind === 'audio_config') audio = true;
        else if (packet.kind === 'audio' && (!audio || packet.bytes.length % 4 !== 0)) throw invalidStream('投屏音频缺少配置或 PCM 双声道对齐无效');
        ++packets;
      }
      return decoded;
    },
    snapshot: () => Object.freeze({ epoch, packets, pendingBytes: framer.pendingBytes() }),
    finish: framer.finish,
    reset() { framer.reset(); epoch = 0; packets = 0; video = false; videoConfig = false; audio = false; },
  };
}
