import assert from 'node:assert/strict';
import { copyFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
export const deviceId = 'fps-0001';
export const packageName = 'org.smoke.fps.game';
export function encodeArgv(args) {
  assert.ok(Array.isArray(args) && args.length <= 16); const parts = [Buffer.alloc(4)]; parts[0].writeUInt32LE(args.length);
  for (const arg of args) { const text = Buffer.from(arg); assert.ok(text.length <= 4096); const size = Buffer.alloc(4); size.writeUInt32LE(text.length); parts.push(size, text); }
  return Buffer.concat(parts);
}
async function writeBytes(path, bytes) {
  const handle = await open(path, 'wx');
  try { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes.subarray(offset, offset + 4096)); assert.ok(result.bytesWritten > 0); offset += result.bytesWritten; } }
  finally { await handle.close(); }
}
// 调用计划只允许固定argv和显式原字节；命令及身份样本由已冻结AOSP路由模块提供。
export async function prepareFixture(directory, binary, contract, report) {
  assert.equal(contract.frozen, true, 'FPS-OFFICIAL-ROUTE-NOT-FROZEN');
  assert.ok(Array.isArray(contract.cases) && contract.cases.length > 0 && contract.cases.length <= 16);
  const root = join(directory, 'fixture'); await mkdir(root); const adb = join(root, 'fake-adb.exe'); await copyFile(binary, adb);
  assert.equal((await fileIdentity(binary)).sha256, (await fileIdentity(adb)).sha256);
  const commands = [...contract.shared, ...contract.cases.flatMap(value => value.commands)];
  for (const scenario of contract.cases) {
    assert.match(scenario.id, /^[a-z][a-z0-9-]{0,47}$/); const folder = join(root, 'inputs', scenario.id); await mkdir(folder, { recursive: true });
    const specs = [...contract.shared, ...scenario.commands]; assert.ok(specs.length <= 32);
    const unique = new Set();
    for (const [index, spec] of specs.entries()) {
      const key = encodeArgv(spec.argv).toString('hex'); assert.ok(!unique.has(key), 'FPS-FIXTURE-ARGV-UNIQUE'); unique.add(key);
      assert.match(spec.category, /^[a-z][a-z0-9-]{0,47}$/); assert.ok(spec.outputs.length > 0 && spec.outputs.length <= 64);
      const target = join(folder, 'spec-' + String(index + 1).padStart(3, '0')); await mkdir(target);
      await writeBytes(join(target, 'argv.bin'), encodeArgv(spec.argv)); await writeFile(join(target, 'category'), spec.category, { flag: 'wx' });
      for (const [number, value] of spec.outputs.entries()) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); assert.ok(bytes.length <= 1024 * 1024);
        await writeBytes(join(target, 'stdout-' + String(number + 1).padStart(3, '0') + '.bin'), bytes);
      }
    }
  }
  await writeFile(join(root, 'mode'), contract.cases[0].id, { flag: 'wx' });
  report.fixture = { root, executable: await fileIdentity(adb), mode_count: contract.cases.length, command_spec_count: commands.length,
    source: contract.source, route: contract.route, schema: contract.schema };
  return { root, adb, cases: contract.cases };
}
export async function setMode(fixture, mode) {
  assert.ok(fixture.cases.some(value => value.id === mode)); const pending = join(fixture.root, 'mode.tmp'); await writeFile(pending, mode); await rename(pending, join(fixture.root, 'mode'));
}
export async function verifyFixture(fixture, report) { assert.deepEqual(await fileIdentity(fixture.adb), report.fixture.executable); }
export function assertReading(reading, expected) {
  assert.equal(reading.pid, expected.pid ?? 2468); assert.ok(Number.isSafeInteger(reading.captured_at));
  if (expected.fps === null) { assert.ok(reading.fps == null, 'FPS-MISSING-NOT-ZERO'); assert.ok(reading.frame_window == null, 'FPS-MISSING-WINDOW'); }
  else { assert.ok(reading.frame_window, 'FPS-EXACT-PRESENT-WINDOW');
    assert.equal(reading.frame_window.frames, expected.frame_window.frames, 'FPS-EXACT-NEW-PRESENT-COUNT');
    const duration = reading.frame_window.duration_ms;
    assert.ok(Number.isSafeInteger(duration) && duration >= expected.frame_window.min_duration_ms
      && duration <= expected.frame_window.max_duration_ms, 'FPS-HOST-MONOTONIC-WINDOW-RANGE');
    assert.match(reading.frame_window.source, /^sf_present_[a-f0-9]{16}$/);
    const rate = reading.frame_window.frames * 1000 / duration;
    assert.ok(Number.isFinite(reading.fps) && Math.abs(reading.fps - rate) <= 1e-9, 'FPS-DERIVED-FROM-RAW-WINDOW'); }
}
