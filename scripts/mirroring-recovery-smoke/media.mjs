import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scrcpyPacket } from '../mirroring-streaming-smoke/golden.mjs';

const execute = promisify(execFile);

async function run(binary, args, report) {
  const pending = execute(binary, args, { timeout: 30000, windowsHide: true, maxBuffer: 65536 });
  const entry = { pid: pending.child.pid, command: '本轮 FFmpeg 合成媒体', started_at: new Date().toISOString() };
  (report.media_processes ??= []).push(entry);
  try { await pending; }
  finally {
    entry.exit_code = pending.child.exitCode; entry.signal = pending.child.signalCode;
    entry.completed_at = new Date().toISOString();
  }
  assert.equal(entry.exit_code, 0); assert.equal(entry.signal, null);
}

function units(bytes) {
  const starts = [];
  for (let index = 0; index + 4 < bytes.length; index++) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 &&
        (bytes[index + 2] === 1 || (bytes[index + 2] === 0 && bytes[index + 3] === 1))) {
      const prefix = bytes[index + 2] === 1 ? 3 : 4;
      starts.push({ offset: index, payload: index + prefix, type: bytes[index + prefix] & 31 });
      index += prefix;
    }
  }
  return starts.map((item, index) => ({ ...item, bytes: bytes.subarray(item.offset, starts[index + 1]?.offset ?? bytes.length) }));
}

function oggPackets(bytes) {
  const packets = [];
  let offset = 0;
  let fragments = [];
  while (offset + 27 <= bytes.length) {
    assert.equal(bytes.toString('ascii', offset, offset + 4), 'OggS');
    const count = bytes[offset + 26];
    const table = bytes.subarray(offset + 27, offset + 27 + count);
    let payload = offset + 27 + count;
    for (const length of table) {
      fragments.push(bytes.subarray(payload, payload + length));
      payload += length;
      if (length < 255) {
        packets.push(Buffer.concat(fragments));
        fragments = [];
      }
    }
    offset = payload;
  }
  assert.equal(offset, bytes.length);
  assert.equal(fragments.length, 0);
  return packets;
}

export async function prepareMedia(directory, fixture, device, report) {
  const videoPath = join(directory, 'webrtc-video.h264');
  const audioPath = join(directory, 'webrtc-audio.opus');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=30',
    '-frames:v', '120', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-profile:v', 'baseline',
    '-x264-params', 'keyint=30:repeat-headers=1:aud=1', '-f', 'h264', '-y', videoPath,
  ], report);
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-frame_duration', '20', '-f', 'opus', '-y', audioPath,
  ], report);
  const videoUnits = units(await readFile(videoPath));
  const config = Buffer.concat(videoUnits.filter((item) => item.type === 7 || item.type === 8).slice(0, 2).map((item) => item.bytes));
  assert.ok(config.length > 0);
  const frames = [];
  let pending = [];
  for (const item of videoUnits) {
    if (item.type === 9 && pending.length) { frames.push(pending); pending = []; }
    if (item.type === 1 || item.type === 5) pending.push(item);
  }
  if (pending.length) frames.push(pending);
  assert.ok(frames.length >= 90);
  const header = Buffer.alloc(12);
  header.write('h264', 'ascii');
  header.writeUInt32BE(64, 4);
  header.writeUInt32BE(64, 8);
  const video = Buffer.concat([
    header,
    scrcpyPacket(config, 0n, { config: true }),
    ...frames.map((frame, index) => scrcpyPacket(Buffer.concat(frame.map((item) => item.bytes)), BigInt(index * 33333), { key: frame.some((item) => item.type === 5) })),
  ]);
  const opus = oggPackets(await readFile(audioPath));
  assert.ok(opus[0]?.subarray(0, 8).equals(Buffer.from('OpusHead')));
  const audio = Buffer.concat([
    Buffer.from('opus'),
    scrcpyPacket(opus[0], 0n, { config: true }),
    ...opus.slice(2).map((packet, index) => scrcpyPacket(packet, BigInt(index * 20000))),
  ]);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(fixture.plan(device), 'video.bin'), video);
  await writeFile(join(fixture.plan(device), 'audio.bin'), audio);
  return { videoFrames: frames.length, opusPackets: opus.length - 2, videoBytes: video.length, audioBytes: audio.length };
}
