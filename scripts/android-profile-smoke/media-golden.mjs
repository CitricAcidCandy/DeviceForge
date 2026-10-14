import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

// 使用真实编码/解码工具建立原字节黄金，不调用生产媒体解析器。
async function run(executable, args, report) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [],
    errors = [];
  let size = 0;
  child.stdout.on('data', (bytes) => {
    size += bytes.length;
    assert.ok(size <= 1024 * 1024);
    output.push(bytes);
  });
  child.stderr.on('data', (bytes) => {
    size += bytes.length;
    assert.ok(size <= 1024 * 1024);
    errors.push(bytes);
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const stdout = Buffer.concat(output),
    stderr = Buffer.concat(errors);
  report.media_tool_preparation ??= [];
  report.media_tool_preparation.push({
    executable,
    args,
    pid: child.pid,
    ...result,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    completed_at: new Date().toISOString(),
  });
  assert.equal(result.code, 0, 'PROFILE-MEDIA-GOLDEN-TOOL-EXIT');
  assert.equal(result.signal, null);
  return stdout;
}
function nalUnits(bytes) {
  const starts = [];
  for (let offset = 0; offset + 3 < bytes.length; ) {
    if (bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 1) {
      starts.push({ offset, length: 3 });
      offset += 3;
    } else if (
      bytes[offset] === 0 &&
      bytes[offset + 1] === 0 &&
      bytes[offset + 2] === 0 &&
      bytes[offset + 3] === 1
    ) {
      starts.push({ offset, length: 4 });
      offset += 4;
    } else offset++;
  }
  assert.equal(starts[0]?.offset, 0, 'PROFILE-H264-ANNEXB-START');
  return starts.map((value, index) => ({
    type: bytes[value.offset + value.length] & 31,
    bytes: bytes.subarray(value.offset, starts[index + 1]?.offset ?? bytes.length),
  }));
}
export function packet(payload, pts = 0n, { config = false, key = false } = {}) {
  assert.ok(payload.length > 0 && payload.length <= 4 * 1024 * 1024);
  assert.ok(pts >= 0n && pts < 1n << 62n);
  const bytes = Buffer.alloc(12 + payload.length);
  bytes.writeBigUInt64BE(pts | (config ? 1n << 63n : 0n) | (key ? 1n << 62n : 0n));
  bytes.writeUInt32BE(payload.length, 8);
  payload.copy(bytes, 12);
  return bytes;
}
export function stream(golden, expired = false) {
  const meta = Buffer.alloc(12);
  meta.write('h264', 'ascii');
  meta.writeUInt32BE(64, 4);
  meta.writeUInt32BE(48, 8);
  return Buffer.concat([
    Buffer.from([0]),
    meta,
    packet(golden.config, 0n, { config: true }),
    ...golden.units.map((unit, index) =>
      packet(unit.bytes, expired ? BigInt(index + 1) : [8025001n, 8055001n, 8085001n][index], {
        key: unit.key,
      }),
    ),
  ]);
}
export async function prepareGolden(directory, ffmpeg, ffprobe, report) {
  await mkdir(directory);
  const raw = join(directory, 'golden.h264');
  await run(
    ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=64x48:rate=30',
      '-vf',
      "geq=lum='mod(X+Y+N*40,255)':cb=128:cr=128",
      '-frames:v',
      '3',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-x264-params',
      'bframes=0:aud=1:keyint=30:scenecut=0',
      '-threads',
      '1',
      '-f',
      'h264',
      raw,
    ],
    report,
  );
  const bytes = await readFile(raw),
    nals = nalUnits(bytes),
    configs = nals.filter((nal) => [7, 8].includes(nal.type));
  assert.equal(configs.length, 2);
  const units = [];
  for (const nal of nals) {
    if ([7, 8].includes(nal.type)) continue;
    if (nal.type === 9) units.push({ parts: [], key: false });
    assert.ok(units.length > 0, 'PROFILE-H264-AUD-ACCESS-UNIT');
    units.at(-1).parts.push(nal.bytes);
    if (nal.type === 5) units.at(-1).key = true;
  }
  assert.equal(units.length, 3);
  assert.deepEqual(
    units.map((unit) => unit.key),
    [true, false, false],
  );
  const result = {
    config: Buffer.concat(configs.map((nal) => nal.bytes)),
    units: units.map((unit) => ({ key: unit.key, bytes: Buffer.concat(unit.parts) })),
    pngs: [],
  };
  const probe = JSON.parse(
    (
      await run(
        ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'frame=pict_type',
          '-of',
          'json',
          raw,
        ],
        report,
      )
    ).toString(),
  );
  assert.deepEqual(
    probe.frames.map((frame) => frame.pict_type),
    ['I', 'P', 'P'],
  );
  await run(
    ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-n',
      '-threads',
      '1',
      '-i',
      raw,
      '-an',
      '-fps_mode',
      'passthrough',
      '-start_number',
      '0',
      join(directory, 'golden-%06d.png'),
    ],
    report,
  );
  for (let index = 0; index < 3; index++)
    result.pngs.push(
      await readFile(join(directory, 'golden-' + String(index).padStart(6, '0') + '.png')),
    );
  assert.equal(
    new Set(result.pngs.map((bytes) => bytes.toString('base64'))).size,
    3,
    'PROFILE-MEDIA-GOLDEN-UNIQUE-FRAMES',
  );
  report.media_golden = {
    raw: await fileIdentity(raw),
    pngs: await Promise.all(
      result.pngs.map((_, index) =>
        fileIdentity(join(directory, 'golden-' + String(index).padStart(6, '0') + '.png')),
      ),
    ),
    frame_types: ['I', 'P', 'P'],
    pts_us: ['8025001', '8055001', '8085001'],
    selected_index: 1,
  };
  return result;
}
