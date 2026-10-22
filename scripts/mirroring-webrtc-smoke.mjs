import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { assertClean, connected, prepareFixture, readIfExists } from './mirroring-streaming-smoke/fixtures.mjs';
import { prepareMedia } from './mirroring-webrtc-smoke/media.mjs';
import { poll } from './device-provider/client.mjs';

const args = process.argv.slice(2);
const option = (name) => args.find((item) => item.startsWith(name + '='))?.slice(name.length + 1);
for (const name of ['--frozen-input', '--plugin-input', '--tool', '--browser', '--server-version'])
  assert.ok(args.filter((item) => item.startsWith(name + '=')).length <= 1);
assert.ok(args.every((item) => ['--frozen-input=', '--plugin-input=', '--tool=', '--browser=', '--server-version='].some((prefix) => item.startsWith(prefix))));
assert.ok(option('--frozen-input') && option('--plugin-input') && option('--tool'), '必须传入宿主、插件冻结目录和假ADB');
const serverVersion = option('--server-version') ?? '3.3.1';
assert.ok(['3.3.1', '3.3.4'].includes(serverVersion), '服务器版本仅支持3.3.1或3.3.4');

const root = fileURLToPath(new URL('../', import.meta.url));
const frozen = resolve(option('--frozen-input'));
const plugin = resolve(option('--plugin-input'));
const directory = join(root, 'artifacts', 'mirroring-webrtc-smoke-' + randomUUID());
const snapshot = join(directory, 'snapshot');
const report = {
  timestamp: new Date().toISOString(), passed: false, checks: [], requests: [],
  server_version: serverVersion,
  scope: '隔离宿主、同ID插件、真实Edge ICE/视频解码、假ADB/scrcpy及本次资源清理',
  limitations: ['假ADB与FFmpeg媒体不等于真机', '单机回环不等于同事局域网、NAT或TURN', '该驱动不部署到当前7031宿主'],
};
let host;
let stage = '冻结输入';
await mkdir(snapshot, { recursive: true });
try {
  assert.equal(process.platform, 'win32');
  const source = {
    host: join(frozen, 'apk-server.exe'),
    executable: join(plugin, 'deviceforge-mirroring-plugin.exe'),
    manifest: join(plugin, 'manifest.json'),
    adb: resolve(option('--tool')),
  };
  report.inputs = {};
  for (const [name, path] of Object.entries(source)) {
    const destination = join(snapshot, name === 'host' ? 'apk-server.exe' : name === 'executable' ? 'deviceforge-mirroring-plugin.exe' : name === 'manifest' ? 'manifest.json' : 'fake-adb.exe');
    await copyFile(path, destination);
    const before = await fileIdentity(path);
    const actual = await fileIdentity(destination);
    assert.equal(actual.sha256, before.sha256);
    report.inputs[name] = { before, actual };
  }
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sessions?.protocol_version, 5);
  assert.deepEqual(manifest.sessions?.operations.map((entry) => entry.name).sort(), ['open', 'open_webrtc']);
  const fixture = await prepareFixture(directory, join(snapshot, 'fake-adb.exe'), {
    'webrtc-check': {}, 'no-answer': {}, 'legacy-check': {},
  });
  for (const device of ['webrtc-check', 'no-answer', 'legacy-check'])
    await writeFile(join(fixture.plan(device), 'server-version'), serverVersion, { flag: 'wx' });
  report.media = await prepareMedia(snapshot, fixture, 'webrtc-check');
  const config = join(snapshot, 'mirroring.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, scrcpy: fixture.adb, adb: fixture.adb, live: { scrcpy_server: fixture.server, server_version: serverVersion } }), { flag: 'wx' });
  manifest.executable = join(snapshot, 'deviceforge-mirroring-plugin.exe');
  manifest.args = ['--config', config];
  host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'), directory: join(directory, 'data'), report, port: await reservePort() });
  await host.ready();
  const deployment = join(host.plugins, 'mirroring');
  await mkdir(deployment);
  await writeFile(join(deployment, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  const loaded = await host.client.post('/api/v2/plugins/mirroring/load');
  assert.equal(loaded.state, 'loaded');
  assert.deepEqual(loaded.sessions.sort(), ['plugin.mirroring.open', 'plugin.mirroring.open_webrtc']);
  report.checks.push({ name: '同插件新旧贡献及隔离宿主', passed: true, pid: host.child.pid });

  stage = '真实浏览器WebRTC';
  const browserArgs = [join(root, 'frontend', 'scripts', 'webrtc-browser-probe.ts'), '--base-url=' + host.client.base, '--device-id=webrtc-check', '--audio=false'];
  if (option('--browser')) browserArgs.push('--browser=' + option('--browser'));
  const child = spawn(process.execPath, browserArgs, { cwd: join(root, 'frontend'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const output = [];
  const errors = [];
  child.stdout.on('data', (bytes) => output.push(bytes));
  child.stderr.on('data', (bytes) => errors.push(bytes));
  const timeout = setTimeout(() => child.kill(), 120000);
  const exit = await Promise.race([
    new Promise((done) => child.once('close', (code, signal) => done({ code, signal }))),
  ]).finally(() => clearTimeout(timeout));
  report.browser = { exit, stdout: Buffer.concat(output).toString('utf8').slice(-16000), stderr: Buffer.concat(errors).toString('utf8').slice(-4000) };
  assert.equal(exit.code, 0, '真实浏览器联调失败');
  const parsed = JSON.parse(report.browser.stdout.trim().split('\n').at(-1));
  assert.equal(parsed.passed, true);
  const control = await readIfExists(join(fixture.plan('webrtc-check'), 'epoch-1', 'control.bin'));
  assert.ok(control);
  const observedKeys = [];
  let resets = 0;
  for (let offset = 0; offset < control.length;) {
    if (control[offset] === 17) { resets++; offset++; continue; }
    assert.ok(offset + 14 <= control.length, '设备控制报文不得截断');
    observedKeys.push(control.subarray(offset, offset + 14));
    offset += 14;
  }
  assert.deepEqual(observedKeys, [
    Buffer.from([0, 0, ...new Array(12).fill(0)]),
    Buffer.from([0, 1, ...new Array(12).fill(0)]),
  ], '可靠数据通道按键必须原字节且有序');
  assert.ok(resets >= 1, '设备控制 socket 必须收到 reset_video 字节');
  report.control = { exactKeys: true, resets, bytes: control.length };
  await assertClean(fixture, 'webrtc-check');
  report.checks.push({ name: 'ICE/真实视频帧/控制/释放及假设备资源清理', passed: true });

  stage = '未应答协商取消';
  const unanswered = await host.client.post('/api/v2/sessions', {
    operation: 'plugin.mirroring.open_webrtc',
    input: { device_id: 'no-answer', audio: false, control: false, reconnect_attempts: 0 },
  }, { status: 202 });
  await poll(async () => {
    const page = await host.client.json(`/api/v2/sessions/${unanswered.id}/output?after=0&limit=100`);
    return { page, text: Buffer.concat(page.chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => Buffer.from(chunk.bytes))).toString('utf8') };
  }, (value) => value.text.includes('"type":"offer"'), '未应答会话offer');
  const cancellation = await host.client.post(`/api/v2/sessions/${unanswered.id}/cancel`);
  assert.equal(cancellation.id, unanswered.id);
  const unansweredFinal = await poll(() => host.client.json(`/api/v2/sessions/${unanswered.id}`),
    (session) => session.status === 'finished', '未应答取消终态');
  assert.equal(unansweredFinal.completion.cleanup, 'complete');
  assert.equal(unansweredFinal.completion.process_exited, true);
  report.unanswered = { session: unansweredFinal, cancellation };
  await host.client.post(`/api/v2/sessions/${unanswered.id}/release`, undefined, { status: 202 });
  await assertClean(fixture, 'no-answer');
  report.checks.push({ name: '未应答协商取消与设备资源清理', passed: true, session: unanswered.id });

  stage = '旧open兼容';
  const legacy = await host.client.post('/api/v2/sessions', { operation: 'plugin.mirroring.open', input: { device_id: 'legacy-check', audio: false, control: false, reconnect_attempts: 0 } }, { status: 202 });
  await poll(async () => host.client.json(`/api/v2/sessions/${legacy.id}/output?after=0&limit=100`), (page) => page.chunks?.some((chunk) => chunk.stream === 'stdout' && Buffer.from(chunk.bytes).includes(Buffer.from('DFML'))), '旧open DFML媒体输出');
  await connected(fixture, 'legacy-check');
  await host.client.post(`/api/v2/sessions/${legacy.id}/cancel`);
  const finished = await poll(() => host.client.json(`/api/v2/sessions/${legacy.id}`), (session) => session.status === 'finished', '旧open释放');
  report.legacy = { session: finished };
  assert.equal(finished.completion.cleanup, 'complete');
  assert.equal(finished.completion.process_exited, true);
  await host.client.post(`/api/v2/sessions/${legacy.id}/release`, undefined, { status: 202 });
  await assertClean(fixture, 'legacy-check');
  report.checks.push({ name: '旧open DFML与释放仍可用', passed: true, session: legacy.id });

  await host.shutdown();
  await host.verifyIdentity();
  report.passed = true;
  stage = '完成';
} catch (error) {
  report.failure = { stage, name: error.name, message: error.message, stack: error.stack };
} finally {
  if (host) {
    try { await host.finish(); } catch (error) { report.cleanup_failure = { name: error.name, message: error.message }; report.passed = false; }
  }
  report.inputsAfter = {};
  for (const [name, entry] of Object.entries(report.inputs ?? {})) {
    report.inputsAfter[name] = await fileIdentity(entry.before.path);
    if (report.inputsAfter[name].sha256 !== entry.before.sha256 || report.inputsAfter[name].bytes !== entry.before.bytes) {
      report.inputs_stable = false;
      report.passed = false;
    }
  }
  report.inputs_stable ??= true;
  report.completedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
