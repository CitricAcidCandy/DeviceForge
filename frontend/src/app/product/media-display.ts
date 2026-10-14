import { createBrowserMirroringSink } from '../../features/mirroring-streaming/index.ts';
import type { MirroringStreamSink } from '../../features/mirroring-streaming/index.ts';

// 解码器归产品运行实例持有；页面绑定画布，切页不重置媒体序号。
export function createMediaDisplay() {
  let canvas: HTMLCanvasElement | null = null;
  let decoder: MirroringStreamSink | null = null;
  let audio: AudioContext | null = null;
  let closed = false;
  let failure: unknown = null;
  let audioEnabled = false;
  const sink: MirroringStreamSink = {
    packet(packet, signal) {
      if (!decoder || closed) throw new Error('请先由播放按钮初始化浏览器解码器');
      return decoder.packet(packet, signal);
    },
    reset() { decoder?.reset?.(); },
    dispose() { decoder?.dispose?.(); decoder = null; },
  };
  return {
    sink,
    bind(target: HTMLCanvasElement | null) { canvas = target; },
    error: () => failure,
    async prepare(withAudio: boolean) {
      if (closed) throw new Error('媒体显示实例已关闭');
      if (typeof VideoDecoder === 'undefined') throw new Error('当前浏览器未提供 WebCodecs 视频解码，请使用支持 H.264 的浏览器');
      if (withAudio) { audio ??= new AudioContext(); await audio.resume(); }
      if (decoder && audioEnabled === withAudio) return;
      if (!withAudio && audio?.state === 'running') await audio.suspend();
      decoder?.dispose?.(); failure = null;
      audioEnabled = withAudio;
      decoder = createBrowserMirroringSink({
        videoOutput(frame) {
          try {
            if (!canvas || closed) return;
            if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
            if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('无法创建投屏画布');
            context.drawImage(frame, 0, 0);
          } catch (error) { failure = error; }
          finally { frame.close(); }
        },
        ...(withAudio && audio ? {audioContext: audio} : {}),
        error(error) { failure = error; },
      });
    },
    async dispose() {
      if (closed) return; closed = true;
      sink.dispose?.(); canvas = null;
      const previous = audio; audio = null;
      if (previous && previous.state !== 'closed') await previous.close();
    },
  };
}
