export interface EncodedFrame {
  readonly bytes: Uint8Array;
  readonly timestamp: number;
  readonly keyFrame: boolean;
}
export interface MediaMaterial {
  readonly configuration: Uint8Array;
  readonly frames: readonly EncodedFrame[];
  readonly screenshot: Blob;
  readonly movie: Blob | null;
  readonly movieReason: string | null;
  readonly encoder: VideoEncoderConfig;
}
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function nalUnits(bytes: Uint8Array) {
  const units: { start: number; end: number; type: number }[] = [];
  for (let offset = 0; offset + 3 < bytes.length; offset++) {
    if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) continue;
    const prefix =
      bytes[offset + 2] === 1 ? 3 : bytes[offset + 2] === 0 && bytes[offset + 3] === 1 ? 4 : 0;
    const nal = bytes[offset + prefix];
    if (!prefix || nal === undefined) continue;
    const previous = units.at(-1);
    if (previous) previous.end = offset;
    units.push({ start: offset, end: bytes.length, type: nal & 31 });
    offset += prefix;
  }
  return units;
}
async function png(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('原生画布未生成 PNG'))),
      'image/png',
    ),
  );
}
async function movie(
  canvas: HTMLCanvasElement,
): Promise<{ blob: Blob | null; reason: string | null }> {
  if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function')
    return { blob: null, reason: '当前浏览器缺少 MediaRecorder 或 captureStream' };
  const mime = ['video/mp4;codecs=avc1.42001E', 'video/mp4'].find((value) =>
    MediaRecorder.isTypeSupported(value),
  );
  if (!mime) return { blob: null, reason: '当前原生 MediaRecorder 不支持 MP4 编码' };
  const stream = canvas.captureStream(10);
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  let failure: unknown = null;
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener('error', (event) => {
    failure = event;
  });
  try {
    recorder.start();
    const drawing = canvas.getContext('2d');
    if (!drawing) throw new Error('录制画布上下文缺失');
    for (let index = 0; index < 10; index++) {
      drawing.fillStyle = index % 2 ? '#20d020' : '#e02020';
      drawing.fillRect(0, 0, 64, 64);
      await wait(100);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('原生 MP4 编码器停止超时')), 5000);
      recorder.addEventListener(
        'stop',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      recorder.stop();
    });
    if (failure || !chunks.length) return { blob: null, reason: '原生 MP4 录制没有完整输出' };
    return { blob: new Blob(chunks, { type: 'video/mp4' }), reason: null };
  } catch (error) {
    return { blob: null, reason: error instanceof Error ? error.message : '原生 MP4 录制失败' };
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    for (const track of stream.getTracks()) track.stop();
  }
}

// 素材由本次真实浏览器原生编码器生成，不能用模拟解码器替代画面证据。
export async function createMediaMaterial(): Promise<MediaMaterial> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined')
    throw new Error('当前浏览器缺少原生 WebCodecs');
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const drawing = canvas.getContext('2d');
  if (!drawing) throw new Error('无法创建原生编码画布');
  let supported: VideoEncoderConfig | null = null;
  for (const codec of ['avc1.42001e', 'avc1.4d001e', 'avc1.64001e']) {
    const configuration: VideoEncoderConfig = {
      codec,
      width: 64,
      height: 64,
      bitrate: 300000,
      framerate: 30,
      latencyMode: 'realtime',
      avc: { format: 'annexb' },
    };
    try {
      if ((await VideoEncoder.isConfigSupported(configuration)).supported) {
        supported = configuration;
        break;
      }
    } catch {}
  }
  if (!supported) throw new Error('原生浏览器未提供可用 H.264 AnnexB 编码配置');
  const frames: EncodedFrame[] = [];
  let encodingError: Error | null = null;
  const encoder = new VideoEncoder({
    output(chunk) {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      frames.push({ bytes, timestamp: chunk.timestamp, keyFrame: chunk.type === 'key' });
    },
    error(error) {
      encodingError = error;
    },
  });
  try {
    encoder.configure(supported);
    for (const [index, color] of ['#e02020', '#20d020', '#2020e0'].entries()) {
      drawing.fillStyle = color;
      drawing.fillRect(0, 0, 64, 64);
      const frame = new VideoFrame(canvas, { timestamp: index * 33333 });
      try {
        encoder.encode(frame, { keyFrame: true });
      } finally {
        frame.close();
      }
    }
    await encoder.flush();
    if (encodingError) throw encodingError;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  const first = frames[0];
  if (!first || frames.length !== 3 || !frames.every((frame) => frame.keyFrame))
    throw new Error('原生 H.264 编码器没有交付三份关键帧');
  const units = nalUnits(first.bytes);
  const parameterSets = units.filter((unit) => unit.type === 7 || unit.type === 8);
  if (
    !parameterSets.some((unit) => unit.type === 7) ||
    !parameterSets.some((unit) => unit.type === 8)
  )
    throw new Error('原生 AnnexB 缺少 SPS/PPS');
  const configuration = concatenate(
    parameterSets.map((unit) => first.bytes.slice(unit.start, unit.end)),
  );
  const normalized = frames.map((frame) => ({
    ...frame,
    bytes: concatenate(
      nalUnits(frame.bytes)
        .filter((unit) => unit.type !== 7 && unit.type !== 8)
        .map((unit) => frame.bytes.slice(unit.start, unit.end)),
    ),
  }));
  drawing.fillStyle = '#e02020';
  drawing.fillRect(0, 0, 64, 64);
  const screenshot = await png(canvas);
  const recorded = await movie(canvas);
  return {
    configuration,
    frames: normalized,
    screenshot,
    movie: recorded.blob,
    movieReason: recorded.reason,
    encoder: supported,
  };
}
export function dfml(
  kind: 1 | 2 | 3 | 4 | 5,
  payload: Uint8Array | object,
  flags = 0,
  timestamp = 0,
  epoch = 1,
): Uint8Array {
  const bytes =
    payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload));
  const header = new Uint8Array(24);
  header.set([68, 70, 77, 76, 1, kind]);
  const view = new DataView(header.buffer);
  view.setUint16(6, flags);
  view.setBigUint64(8, BigInt(timestamp));
  view.setUint32(16, bytes.length);
  view.setUint32(20, epoch);
  return concatenate([header, bytes]);
}
export function dfmlChunks(packets: readonly Uint8Array[]): readonly number[][] {
  const bytes = concatenate(packets);
  const chunks: number[][] = [];
  // 故意把首个包头拆开，随后保持每块不超过公开 8192 字节上限。
  for (let offset = 0; offset < bytes.length; ) {
    const count = offset === 0 ? 7 : Math.min(8192, bytes.length - offset);
    chunks.push([...bytes.slice(offset, offset + count)]);
    offset += count;
  }
  return chunks;
}
export function pcm(): Uint8Array {
  const bytes = new Uint8Array(4800 * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4800; index++) {
    const sample = Math.round(Math.sin((index * Math.PI * 2 * 440) / 48000) * 8192);
    view.setInt16(index * 4, sample, true);
    view.setInt16(index * 4 + 2, Math.round(sample / 2), true);
  }
  return bytes;
}
export async function digest(blob: Blob): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
