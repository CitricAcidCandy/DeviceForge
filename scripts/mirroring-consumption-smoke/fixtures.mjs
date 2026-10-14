import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep, toNamespacedPath } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import {
  startProbe,
  finishProbe,
  finishPendingProbes,
} from '../harmony-screenshot-smoke/fixtures.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { invalidVideo, recordArgv, video } from './contracts.mjs';

export { finishPendingProbes };
const canonical = (value) => toNamespacedPath(resolve(value)).toLowerCase();

export async function prepareTools(context, source) {
  const directory = join(context.directory, 'tool');
  await mkdir(directory);
  context.toolDirectory = directory;
  context.toolBinary = join(directory, 'fake-scrcpy.exe');
  context.adbBinary = join(directory, 'fake-adb.exe');
  await copyFile(source, context.toolBinary);
  await copyFile(source, context.adbBinary);
  await writeFile(join(directory, 'expected.mp4'), video, { flag: 'wx' });
  await writeFile(join(directory, 'invalid.mp4'), invalidVideo, { flag: 'wx' });
  context.report.fixture_inputs = await Promise.all(
    [
      context.toolBinary,
      context.adbBinary,
      join(directory, 'expected.mp4'),
      join(directory, 'invalid.mp4'),
    ].map(fileIdentity),
  );
  const identity = await fileIdentity(source);
  for (const actual of context.report.fixture_inputs.slice(0, 2))
    assert.equal(actual.sha256, identity.sha256);
  context.report.fixture = {
    source: identity,
    boundary: '可控std-only scrcpy/ADB入口与36字节合成容器，不证明真实编码或设备连接',
  };
}

export async function started(context, ordinal, input) {
  const directory = join(context.toolDirectory, 'call-' + String(ordinal).padStart(2, '0'));
  const ready = await poll(
    async () => {
      try {
        return JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    Boolean,
    '录像实际工具就绪',
    12000,
  );
  assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
  const probe = await startProbe(
    context.probeBinary,
    ready.pid,
    join(directory, 'process'),
    context.pluginBinary,
  );
  assert.equal(canonical(probe.ready.target.exe), canonical(context.toolBinary));
  assert.equal(probe.ready.target.state, 'running');
  assert.equal(probe.ready.parent.state, 'running');
  const call = { ordinal, directory, ready, probe };
  const entry = { ordinal, directory, ...ready, probe_ready: probe.ready };
  context.calls.push(call);
  context.report.tools.push(entry);
  if (!input) {
    assert.deepEqual(ready.argv, ['--version']);
  } else {
    const path = ready.argv[6]?.slice('--record='.length);
    assert.ok(ready.argv[6]?.startsWith('--record=') && isAbsolute(path));
    assert.equal(basename(path), 'screen.mp4');
    assert.ok(canonical(path).startsWith(canonical(context.authorizedTemporaryRoot) + sep));
    assert.equal(basename(dirname(path)), 'outputs');
    assert.ok(
      !context.calls
        .slice(0, -1)
        .some(
          (value) => value.outputRoot && canonical(value.outputRoot) === canonical(dirname(path)),
        ),
    );
    const outputMetadata = await lstat(dirname(path));
    assert.ok(outputMetadata.isDirectory() && !outputMetadata.isSymbolicLink());
    assert.deepEqual(ready.argv, recordArgv(input, path));
    assert.equal(canonical(ready.adb), canonical(context.adbBinary));
    const expected = ordinal === 5 ? invalidVideo : video;
    assert.deepEqual(await readFile(path), expected);
    assert.deepEqual(await readFile(join(directory, 'observed.mp4')), expected);
    call.outputPath = path;
    call.outputRoot = dirname(path);
    entry.output_before = await fileIdentity(path);
    entry.observed = await fileIdentity(join(directory, 'observed.mp4'));
  }
  return call;
}

export async function release(call) {
  await writeFile(join(call.directory, 'release'), '1', { flag: 'wx' });
}

export async function finished(context, call, cancelled = false) {
  let timer;
  try {
    const observed = await Promise.race([
      finishProbe(call.probe),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('录像直接父子实际退出确认超时')), 8000);
      }),
    ]);
    assert.equal(observed.exit.target.state, 'exited');
    assert.equal(observed.exit.parent.state, 'exited');
    assert.equal(observed.exit.parent.exit_code, 0);
    if (cancelled) assert.notEqual(observed.exit.target.exit_code, 0);
    else assert.equal(observed.exit.target.exit_code, 0);
    context.report.tools.find((value) => value.ordinal === call.ordinal).process = observed;
    if (call.outputPath) await assert.rejects(lstat(call.outputPath), { code: 'ENOENT' });
  } finally {
    clearTimeout(timer);
  }
}

export async function exactTools(context) {
  const calls = (await readdir(context.toolDirectory))
    .filter((name) => /^call-\d+$/.test(name))
    .sort();
  assert.equal(calls.length, 8);
  assert.equal(context.calls.length, 8);
  assert.equal(context.report.tools.length, 8);
  for (const entry of context.report.tools) assert.equal(entry.process.exit.target.state, 'exited');
}
