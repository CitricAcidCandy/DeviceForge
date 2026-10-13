import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { scrcpyAudio, scrcpyVideo } from './golden.mjs';

export async function prepareFixture(directory, binary, cases) {
  const root = join(directory, 'fixture'); await mkdir(join(root, 'plans'), { recursive: true });
  const adb = join(root, process.platform === 'win32' ? 'fake-adb.exe' : 'fake-adb');
  await copyFile(binary, adb);
  const server = join(root, 'scrcpy-server.jar'); await writeFile(server, Buffer.from('独立scrcpy-server协议占位输入', 'utf8'), { flag: 'wx' });
  for (const [device, options] of Object.entries(cases)) {
    assert.match(device, /^[a-zA-Z0-9-]{1,80}$/);
    const plan = join(root, 'plans', device); await mkdir(plan);
    await writeFile(join(plan, 'video.bin'), scrcpyVideo()); await writeFile(join(plan, 'audio.bin'), scrcpyAudio());
    if (options.disconnectFirst) await writeFile(join(plan, 'disconnect-first'), '1');
    if (options.cleanupDenied) await writeFile(join(plan, 'cleanup-denied'), '1');
    if (options.gateShort) await writeFile(join(plan, 'gate-short'), '1');
    if (options.badVideo) await writeFile(join(plan, 'bad-video.bin'), Buffer.from('xxxx00000000'));
  }
  return { root, adb, server, plan: device => join(root, 'plans', device) };
}

export function decodeArgv(bytes) {
  let offset = 0;
  const number = () => { assert.ok(offset + 4 <= bytes.length); const value = bytes.readUInt32LE(offset); offset += 4; return value; };
  const count = number(); assert.ok(count <= 32); const args = [];
  for (let index = 0; index < count; index++) {
    const length = number(); assert.ok(length <= 8192 && offset + length <= bytes.length);
    args.push(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length))); offset += length;
  }
  assert.equal(offset, bytes.length); return args;
}

export async function calls(fixture) {
  const directories = (await readdir(fixture.root)).filter(name => /^call-\d{3}$/.test(name)).sort();
  return Promise.all(directories.map(async name => {
    const directory = join(fixture.root, name);
    return { directory, argv: decodeArgv(await readFile(join(directory, 'argv.bin'))),
      pid: Number(await readFile(join(directory, 'pid'), 'utf8')), category: await readFile(join(directory, 'category'), 'utf8') };
  }));
}

export async function readIfExists(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function connected(fixture, device, epoch = 1) {
  const directory = join(fixture.plan(device), `epoch-${epoch}`);
  await poll(() => readIfExists(join(directory, 'media-sent')), Boolean, '本次原生媒体socket发送');
  return directory;
}

export async function controlObserved(directory, expected) {
  return poll(() => readIfExists(join(directory, 'control.bin')), bytes => bytes?.equals(expected), '控制socket原字节');
}

export async function assertClean(fixture, device) {
  const plan = fixture.plan(device);
  for (const name of ['remote-dir', 'remote-pid', 'remote-owner', 'forward-owned']) {
    assert.equal(await readIfExists(join(plan, name)), null, '所有权模拟必须明确清除：' + name);
  }
  assert.deepEqual(await readFile(join(plan, 'remote-cleaned')), Buffer.from('1'));
  assert.deepEqual(await readFile(join(plan, 'forward-removed')), Buffer.from('1'));
}
