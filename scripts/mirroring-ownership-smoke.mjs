import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { prepareMedia } from './mirroring-webrtc-smoke/media.mjs';
import { runOwnershipBrowser } from './mirroring-ownership-smoke/browser.mjs';
import { poll } from './device-provider/client.mjs';

const args = process.argv.slice(2);
const option = (name) => args.find((item) => item.startsWith(name + '='))?.slice(name.length + 1);
for (const name of ['--frozen-input', '--plugin-input', '--tool', '--browser'])
  assert.ok(args.filter((item) => item.startsWith(name + '=')).length <= 1);
assert.ok(args.every((item) => ['--frozen-input=', '--plugin-input=', '--tool=', '--browser=']
  .some((prefix) => item.startsWith(prefix))));
assert.ok(option('--frozen-input') && option('--plugin-input') && option('--tool'), '必须指定冻结宿主、插件及独立假ADB');

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'artifacts', 'mirroring-ownership-smoke-' + randomUUID());
const snapshot = join(directory, 'snapshot');
const device = 'ownership-' + randomUUID();
const report = {
  timestamp: new Date().toISOString(), passed: false, checks: [], requests: [],
  scope: '隔离Rust宿主、三真实浏览器WebRTC会话、跨进程所有权协调、独立假ADB与scrcpy控制原帧',
  limitations: ['合成媒体及设备回包不是真机原生菜单操作',
    '本机三个浏览器客户端均为主控身份，非主控身份与抢回拒绝沿独立HTTP身份测试及所有权规则测试确认',
    '不部署到现有7031，不代表同事局域网延迟或正式分发验收'],
};
let host;
let stage = '冻结输入';
await mkdir(snapshot, { recursive: true });
try {
  assert.equal(process.platform, 'win32');
  const inputs = {
    host: join(resolve(option('--frozen-input')), 'apk-server.exe'),
    plugin: join(resolve(option('--plugin-input')), 'deviceforge-mirroring-plugin.exe'),
    manifest: join(resolve(option('--plugin-input')), 'manifest.json'),
    adb: resolve(option('--tool')),
  };
  report.inputs = {};
  for (const [name, path] of Object.entries(inputs)) {
    const destination = join(snapshot, { host: 'apk-server.exe', plugin: 'deviceforge-mirroring-plugin.exe',
      manifest: 'manifest.json', adb: 'fake-adb.exe' }[name]);
    await copyFile(path, destination);
    const before = await fileIdentity(path);
    const frozen = await fileIdentity(destination);
    assert.equal(frozen.sha256, before.sha256);
    report.inputs[name] = { before, frozen };
  }
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sessions?.client_context, true, '插件必须显式声明可信客户端上下文');
  const fixture = join(directory, 'fixture');
  const plan = join(fixture, 'plans', device);
  await mkdir(plan, { recursive: true });
  const adb = join(fixture, 'fake-adb.exe');
  await copyFile(join(snapshot, 'fake-adb.exe'), adb);
  const server = join(fixture, 'scrcpy-server.jar');
  await writeFile(server, Buffer.from('独立控制权夹具服务输入', 'utf8'), { flag: 'wx' });
  report.media = await prepareMedia(snapshot, { plan: () => plan }, device);
  const config = join(snapshot, 'mirroring.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, scrcpy: adb, adb,
    live: { scrcpy_server: server, server_version: '3.3.1' } }), { flag: 'wx' });
  manifest.executable = join(snapshot, 'deviceforge-mirroring-plugin.exe');
  manifest.args = ['--config', config];
  host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'), directory: join(directory, 'data'),
    report, port: await reservePort() });
  await host.ready();
  const deployment = join(host.plugins, 'mirroring');
  await mkdir(deployment);
  await writeFile(join(deployment, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  const loaded = await host.client.post('/api/v2/plugins/mirroring/load');
  assert.equal(loaded.state, 'loaded');
  report.checks.push({ name: '隔离空宿主热载同ID投屏插件', passed: true, pid: host.child.pid, device });

  stage = '三会话控制权与剪贴板真实协议';
  report.browser = await runOwnershipBrowser({ root, baseUrl: host.client.base, deviceId: device,
    directory, plan, executable: option('--browser') });
  assert.equal(report.browser.passed, true, '三会话浏览器验收失败');
  report.checks.push(...report.browser.result.checks);

  stage = '三会话终态与设备资源清理';
  const active = await poll(() => host.client.json('/api/v2/sessions'),
    (sessions) => sessions.every((entry) => entry.status === 'finished'), '全部会话终态');
  for (const session of active) {
    assert.equal(session.completion.cleanup, 'complete');
    assert.equal(session.completion.process_exited, true);
    await host.client.post('/api/v2/sessions/' + session.id + '/release', undefined, { status: 202 });
  }
  assert.deepEqual(await host.client.json('/api/v2/sessions'), []);
  const sessions = await readdir(join(plan, 'sessions'));
  report.resources = [];
  for (const id of sessions) {
    const path = join(plan, 'sessions', id);
    assert.equal(await readFile(join(path, 'cleaned'), 'utf8'), '1');
    for (const name of ['remote-dir', 'remote-pid']) {
      await assert.rejects(readFile(join(path, name)), (error) => error.code === 'ENOENT');
    }
    const mode = await readFile(join(path, 'mode'), 'utf8');
    const scid = await readFile(join(path, 'scid'), 'utf8');
    const forward = join(plan, 'forwards', scid);
    assert.equal(await readFile(join(forward, 'removed'), 'utf8'), '1');
    await assert.rejects(readFile(join(forward, 'owned')), (error) => error.code === 'ENOENT');
    report.resources.push({ id, mode, scid, cleaned: true });
  }
  assert.equal(report.resources.filter((entry) => entry.mode === 'video').length, 3);
  assert.equal(report.resources.filter((entry) => entry.mode === 'control').length, 3);
  for (const call of (await readdir(fixture)).filter((name) => /^call-\d{4}$/.test(name))) {
    const pid = Number(await readFile(join(fixture, call, 'pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH', '本次假ADB直接进程必须退出');
  }
  const unloaded = await host.client.post('/api/v2/plugins/mirroring/unload');
  assert.equal(unloaded.state, 'unloaded');
  assert.equal(unloaded.cleanup_failed, false);
  report.checks.push({ name: '六组媒体与控制资源清理、直接工具退出及插件可卸载', passed: true,
    resources: report.resources.length });
  await host.shutdown();
  await host.verifyIdentity();
  report.passed = true;
} catch (error) {
  report.failure = { stage, name: error.name, message: error.message, stack: error.stack };
} finally {
  if (host) {
    try { await host.finish(); } catch (error) { report.cleanupFailure = error.message; report.passed = false; }
  }
  report.inputsAfter = {};
  for (const [name, entry] of Object.entries(report.inputs ?? {})) {
    const after = await fileIdentity(entry.before.path);
    report.inputsAfter[name] = after;
    if (after.sha256 !== entry.before.sha256 || after.bytes !== entry.before.bytes) report.passed = false;
  }
  report.completedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
