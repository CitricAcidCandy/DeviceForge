import assert from 'node:assert/strict';
import test from 'node:test';
import { createMirroringFramer } from '../src/features/mirroring-streaming/services/framing.ts';
import { createMirroringStream } from '../src/features/mirroring-streaming/services/stream.ts';
import {
  encodeMirroringControl,
  normalizeStreamInput,
} from '../src/features/mirroring-streaming/utils/rules.ts';
import { mirroringH264Codec } from '../src/features/mirroring-streaming/services/h264.ts';
import { decodeMirroringPcm } from '../src/features/mirroring-streaming/services/audio.ts';
import { createMirroringVideoDecoder } from '../src/features/mirroring-streaming/services/video.ts';
import type { MirroringVideoEnvironment } from '../src/features/mirroring-streaming/services/video.ts';
import { ApiError } from '../src/services/api/index.ts';
import { deferred, signal } from './fixtures.ts';

function frame(kind: number, data: unknown, flags = 0, epoch = 1, timestamp = 0n): number[] {
  const payload =
    data instanceof Uint8Array ? data : new TextEncoder().encode(JSON.stringify(data));
  const bytes = new Uint8Array(24 + payload.length);
  bytes.set([68, 70, 77, 76, 1, kind]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, flags);
  view.setBigUint64(8, timestamp);
  view.setUint32(16, payload.length);
  view.setUint32(20, epoch);
  bytes.set(payload, 24);
  return Array.from(bytes);
}
const videoConfig = { codec: 'h264', format: 'annexb', width: 640, height: 480 };
const audioConfig = { codec: 'pcm_s16le', sample_rate: 48000, channels: 2 };
const sps = new Uint8Array([0, 0, 0, 1, 103, 100, 0, 31, 0, 0, 0, 1, 104, 1]);

test('二进制分帧在每个包头与载荷断点重组，完整原字节无文本转换', () => {
  const bytes = frame(2, new Uint8Array([0, 255, 128, 13, 10]), 1, 3, 123456n);
  for (let split = 1; split < bytes.length; ++split) {
    const parser = createMirroringFramer();
    assert.equal(parser.push(bytes.slice(0, split)).length, 0);
    assert.equal(parser.pendingBytes(), split);
    const packet = parser.push(bytes.slice(split))[0];
    assert.equal(packet?.kind, 'video');
    if (packet?.kind !== 'video') throw new Error('未得到视频包');
    assert.equal(packet.epoch, 3);
    assert.equal(packet.timestampUs, 123456);
    assert.equal(packet.keyFrame, true);
    assert.deepEqual(packet.bytes, new Uint8Array([0, 255, 128, 13, 10]));
    assert.equal(parser.pendingBytes(), 0);
    parser.finish();
  }
});

test('最多4MiB帧跨8192字节输出块，有界重组；错误头与截断尾部拒绝', () => {
  const parser = createMirroringFramer();
  const large = frame(2, new Uint8Array(32768).fill(128));
  let packets = 0;
  for (let offset = 0; offset < large.length; offset += 8192)
    packets += parser.push(large.slice(offset, offset + 8192)).length;
  assert.equal(packets, 1);
  assert.equal(parser.pendingBytes(), 0);
  for (const mutation of [
    (bytes: number[]) => {
      bytes[0] = 0;
    },
    (bytes: number[]) => {
      bytes[4] = 2;
    },
    (bytes: number[]) => {
      bytes[5] = 7;
    },
    (bytes: number[]) => {
      bytes[7] = 3;
    },
    (bytes: number[]) => {
      bytes[23] = 0;
    },
    (bytes: number[]) => {
      bytes[16] = 1;
    },
  ]) {
    const bytes = frame(2, sps);
    mutation(bytes);
    assert.throws(() => parser.push(bytes), ApiError);
    assert.equal(parser.pendingBytes(), 0);
  }
  assert.throws(() => parser.push(new Array<number>(8193).fill(0)), ApiError);
  parser.push(frame(1, videoConfig).slice(0, 25));
  assert.throws(() => parser.finish(), ApiError);
  parser.reset();
  parser.finish();
  assert.throws(
    () => parser.push(frame(2, sps, 0, 1, BigInt(Number.MAX_SAFE_INTEGER) + 1n)),
    ApiError,
  );
});

test('配置与状态校验阻止无效UTF8、额外字段、错误音频、代次回退与缺配置帧', () => {
  const parser = createMirroringFramer();
  for (const bytes of [
    frame(1, new Uint8Array([255])),
    frame(1, { ...videoConfig, private_path: 'x' }),
    frame(3, { ...audioConfig, channels: 1 }),
    frame(5, { state: 'streaming', attempt: 6 }),
  ])
    assert.throws(() => parser.push(bytes), ApiError);
  const stream = createMirroringStream();
  assert.throws(() => stream.push(frame(2, sps, 2)), ApiError);
  stream.reset();
  stream.push(frame(5, { state: 'connecting', attempt: 0 }));
  stream.push(frame(1, videoConfig));
  assert.throws(() => stream.push(frame(2, new Uint8Array([1]), 1)), ApiError);
  stream.reset();
  stream.push(frame(1, videoConfig));
  stream.push(frame(2, sps, 2));
  stream.push(frame(2, new Uint8Array([1]), 1));
  stream.push(frame(3, audioConfig));
  stream.push(frame(4, new Uint8Array([0, 0, 0, 0])));
  assert.equal(stream.snapshot().packets, 5);
  assert.throws(() => stream.push(frame(4, new Uint8Array([0, 0, 0]))), ApiError);
  stream.push(frame(5, { state: 'reconnecting', attempt: 1 }, 0, 2));
  assert.throws(() => stream.push(frame(2, sps, 2, 1)), ApiError);
});

test('控制严格UTF8逐行编码，拒绝越界坐标、断代理字符、客户端路径与超限文本', () => {
  const bytes = encodeMirroringControl({ type: 'text', text: '中文🙂\n第二行' }, 3);
  assert.equal(
    new TextDecoder().decode(new Uint8Array(bytes)),
    '{"type":"text","text":"中文🙂\\n第二行","epoch":3}\n',
  );
  assert.ok(Object.isFrozen(bytes));
  for (const copy_key of ['none', 'copy', 'cut'])
    assert.equal(JSON.parse(new TextDecoder().decode(Uint8Array.from(
      encodeMirroringControl({ type: 'get_clipboard', copy_key }, 1),
    ))).copy_key, copy_key);
  encodeMirroringControl(
    { type: 'touch', action: 'down', x: 639, y: 479, width: 640, height: 480, pressure: 1 },
    1,
  );
  for (const control of [
    { type: 'touch', action: 'down', x: 640, y: 0, width: 640, height: 480 },
    { type: 'text', text: '\ud800' },
    { type: 'text', text: '中'.repeat(101) },
    { type: 'clipboard', text: 'a'.repeat(2049) },
    { type: 'get_clipboard', copy_key: 'paste' },
    { type: 'get_clipboard', copy_key: 'none', text: 'private' },
    { type: 'key', action: 'down', keycode: -1 },
    { type: 'rotate', path: 'client.exe' },
    { type: 'text', text: '\0' },
  ])
    assert.throws(() => encodeMirroringControl(control, 1), ApiError);
  const value = normalizeStreamInput({
    device_id: 'host:5555',
    reconnect_attempts: 5,
    control: false,
    clipboard_autosync: true,
  });
  assert.ok(Object.isFrozen(value));
  for (const input of [
    { device_id: '设备' },
    { device_id: 'valid', duration_ms: 1000 },
    { device_id: 'valid', max_size: 63 },
    { device_id: 'valid', audio: undefined },
    { device_id: 'valid', clipboard_autosync: 1 },
  ])
    assert.throws(() => normalizeStreamInput(input), ApiError);
});

test('剪贴板DFML包跨块重组并严格验证文本和字节限额', () => {
  const bytes = frame(6, { text: '中文🙂\n剪贴板' });
  for (let split = 1; split < bytes.length; ++split) {
    const parser = createMirroringFramer();
    assert.deepEqual(parser.push(bytes.slice(0, split)), []);
    assert.deepEqual(parser.push(bytes.slice(split)), [{
      kind: 'clipboard', epoch: 1, timestampUs: 0, text: '中文🙂\n剪贴板',
    }]);
  }
  assert.deepEqual(createMirroringFramer().push(frame(6, { text: '' }))[0], {
    kind: 'clipboard', epoch: 1, timestampUs: 0, text: '',
  });
  for (const value of [{ text: '\0' }, { text: '\ud800' }, { text: 'private', extra: true }, new Uint8Array([255])])
    assert.throws(() => createMirroringFramer().push(frame(6, value)), ApiError);
  const large = frame(6, { text: 'a'.repeat(262140) });
  const parser = createMirroringFramer();
  assert.throws(() => {
    for (let offset = 0; offset < large.length; offset += 8192)
      parser.push(large.slice(offset, offset + 8192));
  }, ApiError);
  const stream = createMirroringStream();
  assert.throws(() => stream.push(frame(6, { text: '先于代次' })), ApiError);
  stream.reset();
  stream.push(frame(5, { state: 'streaming', attempt: 0 }));
  stream.push(frame(6, { text: '本代' }));
  stream.push(frame(5, { state: 'reconnecting', attempt: 1 }, 0, 2));
  assert.throws(() => stream.push(frame(6, { text: '旧代' })), ApiError);
});

test('H264 SPS派生实际codec，PCM16交错双声道转换保留符号与幅度', () => {
  assert.equal(mirroringH264Codec(sps), 'avc1.64001f');
  assert.throws(() => mirroringH264Codec(new Uint8Array([0, 0, 1, 101, 1])), ApiError);
  const [left, right] = decodeMirroringPcm(new Uint8Array([0, 128, 255, 127, 0, 0, 0, 64]));
  assert.deepEqual(Array.from(left), [-1, 0]);
  assert.deepEqual(Array.from(right), [32767 / 32768, 0.5]);
  assert.throws(() => decodeMirroringPcm(new Uint8Array([0])), ApiError);
});

test('视频等待关键帧且队列超限撤销依赖链，重配与销毁拒绝旧支持结果', async () => {
  let queue = 0;
  let resets = 0;
  let decoded = 0;
  let closes = 0;
  const environment: MirroringVideoEnvironment = {
    supported: async () => true,
    create: () => ({
      get decodeQueueSize() {
        return queue;
      },
      configure: () => {},
      decode: () => {
        ++decoded;
      },
      reset: () => {
        ++resets;
        queue = 0;
      },
      close: () => {
        ++closes;
      },
    }),
  };
  const video = createMirroringVideoDecoder({ output: () => {}, environment, maxDecodeQueue: 2 });
  await video.configure({ codec: 'avc1.64001f', codedWidth: 640, codedHeight: 480 }, signal());
  assert.equal(video.push({ keyFrame: false, timestampUs: 0, bytes: sps }), false);
  assert.equal(video.push({ keyFrame: true, timestampUs: 1, bytes: sps }), true);
  queue = 2;
  assert.equal(video.push({ keyFrame: false, timestampUs: 2, bytes: sps }), false);
  assert.equal(resets, 1);
  assert.equal(decoded, 1);
  assert.equal(video.push({ keyFrame: true, timestampUs: 3, bytes: sps }), true);
  video.dispose();
  assert.equal(closes, 1);
  const cancelledVideo = createMirroringVideoDecoder({ output: () => {}, environment });
  const controller = new AbortController();
  await cancelledVideo.configure(
    { codec: 'avc1.64001f', codedWidth: 640, codedHeight: 480 },
    controller.signal,
  );
  controller.abort();
  assert.equal(cancelledVideo.snapshot().configured, false);
  assert.equal(closes, 2);
  cancelledVideo.dispose();
  const support = deferred<boolean>();
  let created = 0;
  const waiting = createMirroringVideoDecoder({
    output: () => {},
    environment: {
      supported: () => support.promise,
      create: (...args) => {
        ++created;
        return environment.create(...args);
      },
    },
  });
  const configured = waiting.configure(
    { codec: 'avc1.64001f', codedWidth: 640, codedHeight: 480 },
    signal(),
  );
  waiting.dispose();
  await assert.rejects(configured, ApiError);
  support.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, 0);
});
