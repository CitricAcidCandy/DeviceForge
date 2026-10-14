import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { poll } from '../device-provider/client.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import {
  assertClean,
  calls,
  connected,
  controlObserved,
  prepareFixture,
  readIfExists,
} from './fixtures.mjs';
import {
  audioPacket,
  controlGolden,
  dfml,
  parseDfml,
  scrcpyAudio,
  scrcpyVideo,
  splitBytes,
  videoKey,
} from './golden.mjs';

const argumentsList = process.argv.slice(2);
assert.ok(
  argumentsList.length === 1 && argumentsList[0].startsWith('--tool='),
  '使用 --tool=独立原生夹具绝对路径',
);
const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(argumentsList[0].slice('--tool='.length));
const directory = join(root, 'artifacts', 'mirroring-streaming-fixture-self-check-' + randomUUID());
await mkdir(directory, { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  passed: false,
  checks: [],
  processes: [],
  scope: '仅独立原生协议夹具、自有TCP连接与模拟资源清理；未消费宿主、生产插件、前端、真机或性能',
};
const active = new Set(),
  sockets = new Set(),
  processHandles = [];

function command(executable, args) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { pid: child.pid, argv: args, stdout: [], stderr: [] };
  active.add(child);
  const closed = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      active.delete(child);
      entry.exit = { code, signal };
      done(entry);
    });
  });
  closed.catch(() => {});
  child.stdout.on('data', (bytes) => {
    assert.ok(entry.stdout.reduce((sum, value) => sum + value.length, bytes.length) <= 65536);
    entry.stdout.push(bytes);
  });
  child.stderr.on('data', (bytes) => entry.stderr.push(bytes));
  const handle = { child, closed, entry };
  processHandles.push(handle);
  report.processes.push(entry);
  return handle;
}

async function finish(process) {
  let timer;
  try {
    const entry = await Promise.race([
      process.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('自有夹具退出超时')), 5000);
      }),
    ]);
    assert.deepEqual(entry.exit, { code: 0, signal: null });
    return Buffer.concat(entry.stdout);
  } finally {
    clearTimeout(timer);
  }
}

async function openSocket(port) {
  const socket = connect(port, '127.0.0.1');
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  await new Promise((done, reject) => {
    socket.once('connect', done);
    socket.once('error', reject);
  });
  return socket;
}

function receive(socket, expected) {
  const pieces = [];
  let length = 0;
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('黄金媒体接收超时')), 5000);
    const listener = (bytes) => {
      pieces.push(bytes);
      length += bytes.length;
      if (length >= expected) {
        clearTimeout(timer);
        socket.off('data', listener);
        done(Buffer.concat(pieces));
      }
    };
    socket.on('data', listener);
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      if (length < expected) reject(new Error('黄金媒体未收全便关闭'));
    });
  });
}

try {
  report.tool_before = await fileIdentity(binary);
  const fixture = await prepareFixture(directory, binary, { 'self-check': {} });
  const device = 'self-check',
    remote = '/data/local/tmp/deviceforge_' + '1'.repeat(32),
    scid = '1234abcd';
  const invoke = (args) => finish(command(fixture.adb, ['-s', device, ...args]));
  await invoke(['shell', 'mkdir', remote]);
  await invoke(['push', fixture.server, remote + '/server.jar']);
  const portText = (
    await invoke(['forward', '--no-rebind', 'tcp:0', 'localabstract:scrcpy_' + scid])
  )
    .toString('utf8')
    .trim();
  const port = Number(portText);
  assert.ok(port >= 1 && port <= 65535);
  const script = `echo $$ > ${remote}/pid && CLASSPATH=${remote}/server.jar exec app_process / --nice-name=deviceforge_${'1'.repeat(32)} com.genymobile.scrcpy.Server 3.3.1 scid=${scid} tunnel_forward=true video=true audio=true control=true video_codec=h264 audio_codec=raw max_size=1280 max_fps=30 video_bit_rate=2000000 send_device_meta=false send_dummy_byte=false send_codec_meta=true send_frame_meta=true clipboard_autosync=false cleanup=false power_on=false`;
  const server = command(fixture.adb, ['-s', device, 'shell', script]);
  await poll(
    () => readIfExists(join(fixture.plan(device), 'epoch-1/listening')),
    Boolean,
    '独立原生监听',
  );
  const video = await openSocket(port),
    videoPromise = receive(video, scrcpyVideo().length);
  const audio = await openSocket(port),
    audioPromise = receive(audio, scrcpyAudio().length);
  const control = await openSocket(port);
  assert.deepEqual(await videoPromise, scrcpyVideo());
  assert.deepEqual(await audioPromise, scrcpyAudio());
  const epoch = await connected(fixture, device);
  for (const piece of splitBytes(controlGolden)) control.write(piece);
  await controlObserved(epoch, controlGolden);
  report.checks.push({ name: '原生三路socket拆写H264/PCM和控制黄金原字节', passed: true });
  control.end();
  await finish(server);
  video.destroy();
  audio.destroy();
  const cleanup = `i=0; while [ ! -f ${remote}/pid ]; do i=$((i+1)); [ $i -le 10 ] || exit 77; sleep 0.05; done; if [ -f ${remote}/pid ]; then p=$(cat ${remote}/pid); case $p in ''|*[!0-9]*) exit 71;; esac; if [ -e /proc/$p ]; then n=$(tr '\\000' '\\n' < /proc/$p/cmdline | head -n 1); [ "$n" = deviceforge_${'1'.repeat(32)} ] || exit 72; kill -TERM $p || exit 73; i=0; while kill -0 $p 2>/dev/null; do i=$((i+1)); [ $i -le 20 ] || exit 74; sleep 0.05; done; fi; fi; rm -rf ${remote} || exit 75; [ ! -e ${remote} ] || exit 76; echo DFML_CLEAN`;
  assert.equal((await invoke(['shell', cleanup])).toString('utf8'), 'DFML_CLEAN\n');
  await invoke(['forward', '--remove', 'tcp:' + port]);
  await assertClean(fixture, device);
  assert.deepEqual(await readFile(join(epoch, 'peer-closed')), Buffer.from('1'));
  assert.deepEqual(await readFile(join(epoch, 'sockets-closed')), Buffer.from('1'));
  const observedCalls = await calls(fixture);
  assert.equal(observedCalls.length, 6);
  assert.deepEqual(
    observedCalls.map((value) => value.category),
    ['mkdir', 'push', 'forward', 'server', 'cleanup', 'remove-forward'],
  );
  report.checks.push({ name: '真实连接关闭、六独立进程退出及持久远端/映射显式清理', passed: true });
  const wrapped = Buffer.concat([
    dfml(videoKey, { kind: 2, flags: 1, pts: 33333n }),
    dfml(audioPacket, { kind: 4, pts: 20000n }),
  ]);
  let pending = Buffer.alloc(0),
    frames = [];
  for (const piece of splitBytes(wrapped)) {
    const page = parseDfml(Buffer.concat([pending, piece]));
    frames.push(...page.frames);
    pending = page.pending;
  }
  assert.equal(pending.length, 0);
  assert.deepEqual(
    frames.map((frame) => frame.payload),
    [videoKey, audioPacket],
  );
  assert.deepEqual(
    frames.map((frame) => frame.pts),
    ['33333', '20000'],
  );
  report.checks.push({ name: '独立DFML头/拆包黄金自检', passed: true });
  report.tool_after = await fileIdentity(binary);
  assert.deepEqual(report.tool_after, report.tool_before);
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  for (const socket of sockets) socket.destroy();
  for (const child of active) {
    report.forced_cleanup ??= [];
    report.forced_cleanup.push(child.pid);
    child.kill();
  }
  if (report.forced_cleanup) report.passed = false;
  await Promise.allSettled(processHandles.map((handle) => handle.closed));
  report.processes = report.processes.map((entry) => ({
    ...entry,
    stdout: Buffer.concat(entry.stdout).toString('utf8'),
    stderr: Buffer.concat(entry.stderr).toString('utf8'),
  }));
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      directory,
      passed: report.passed,
      checks: report.checks.length,
      failure: report.failure,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
