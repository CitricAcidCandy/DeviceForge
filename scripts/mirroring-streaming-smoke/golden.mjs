import assert from 'node:assert/strict';

// 黄金字节独立定义，不导入生产编码器；仅用于协议转发与帧边界核对。
export const videoConfig = Buffer.from([0, 0, 0, 1, 103, 66, 0, 30, 233, 1, 64, 123, 32,
  0, 0, 0, 1, 104, 206, 6, 226]);
export const videoKey = Buffer.from([0, 0, 0, 1, 101, 136, 0, 255, 128, 1]);
export const videoDelta = Buffer.concat([Buffer.from([0, 0, 0, 1, 65, 154, 0, 254, 127]),
  Buffer.from(Array.from({ length: 9216 }, (_, index) => (index * 31) % 256))]);
export const audioPacket = Buffer.from([0, 0, 255, 127, 0, 128, 255, 255, 1, 0, 254, 255]);
export const deviceName = '设备工坊协议夹具';
export const width = 1280, height = 720;

export function scrcpyPacket(payload, pts = 0n, { config = false, key = false } = {}) {
  assert.ok(Buffer.isBuffer(payload) && payload.length > 0 && payload.length <= 4 * 1024 * 1024);
  assert.ok(pts >= 0n && pts < (1n << 62n));
  const bytes = Buffer.alloc(12 + payload.length);
  bytes.writeBigUInt64BE(pts | (config ? 1n << 63n : 0n) | (key ? 1n << 62n : 0n));
  bytes.writeUInt32BE(payload.length, 8); payload.copy(bytes, 12); return bytes;
}

export function scrcpyVideo({ packets = true } = {}) {
  const meta = Buffer.alloc(12); meta.write('h264', 'ascii');
  meta.writeUInt32BE(width, 4); meta.writeUInt32BE(height, 8);
  return Buffer.concat([meta,
    ...(packets ? [scrcpyPacket(videoConfig, 0n, { config: true }),
      scrcpyPacket(videoKey, 33333n, { key: true }), scrcpyPacket(videoDelta, 66666n)] : [])]);
}

export function scrcpyAudio({ packets = true } = {}) {
  return Buffer.concat([Buffer.from([0, 114, 97, 119]), ...(packets ? [
    scrcpyPacket(audioPacket, 20000n)] : [])]);
}

export function dfml(payload, { kind, flags = 0, pts = 0n, epoch = 1 } = {}) {
  assert.ok(Buffer.isBuffer(payload) && payload.length <= 4 * 1024 * 1024);
  const bytes = Buffer.alloc(24 + payload.length); bytes.write('DFML', 'ascii');
  bytes[4] = 1; bytes[5] = kind; bytes.writeUInt16BE(flags, 6);
  bytes.writeBigUInt64BE(pts, 8); bytes.writeUInt32BE(payload.length, 16);
  bytes.writeUInt32BE(epoch, 20); payload.copy(bytes, 24); return bytes;
}

export function parseDfml(bytes) {
  const frames = []; let offset = 0;
  while (offset + 24 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 24);
    assert.equal(header.subarray(0, 4).toString('ascii'), 'DFML'); assert.equal(header[4], 1);
    assert.ok(header[5] >= 1 && header[5] <= 5);
    const length = header.readUInt32BE(16); assert.ok(length <= 4 * 1024 * 1024);
    if (offset + 24 + length > bytes.length) break;
    const payload = bytes.subarray(offset + 24, offset + 24 + length);
    frames.push({ kind: header[5], flags: header.readUInt16BE(6), pts: header.readBigUInt64BE(8).toString(),
      epoch: header.readUInt32BE(20), payload, ...( [1, 3, 5].includes(header[5]) ? { json: JSON.parse(payload) } : {}) });
    assert.ok(frames.at(-1).epoch >= 1); offset += 24 + length;
  }
  return { frames, pending: bytes.subarray(offset) };
}

export function keyControl(action, keycode, repeat = 0, metastate = 0) {
  const bytes = Buffer.alloc(14); bytes[0] = 0; bytes[1] = action;
  bytes.writeUInt32BE(keycode, 2); bytes.writeUInt32BE(repeat, 6); bytes.writeUInt32BE(metastate, 10);
  return bytes;
}

export function textControl(text) {
  const payload = Buffer.from(text, 'utf8'); const bytes = Buffer.alloc(5 + payload.length);
  bytes[0] = 1; bytes.writeUInt32BE(payload.length, 1); payload.copy(bytes, 5); return bytes;
}

export function touchControl() {
  const bytes = Buffer.alloc(32); bytes[0] = 2; bytes[1] = 0;
  bytes.writeBigUInt64BE(1n, 2); bytes.writeUInt32BE(17, 10); bytes.writeUInt32BE(23, 14);
  bytes.writeUInt16BE(width, 18); bytes.writeUInt16BE(height, 20); bytes.writeUInt16BE(65535, 22);
  bytes.writeUInt32BE(0, 24); bytes.writeUInt32BE(0, 28); return bytes;
}

export const controlGolden = Buffer.concat([keyControl(0, 3), keyControl(1, 3),
  textControl('你好🌍'), touchControl()]);

export const fragmentedSizes = [1, 2, 5, 3, 17, 1, 7, 11];

export function splitBytes(bytes, sizes = fragmentedSizes) {
  const pieces = []; let offset = 0, index = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + sizes[index++ % sizes.length]);
    pieces.push(bytes.subarray(offset, end)); offset = end;
  }
  return pieces;
}
