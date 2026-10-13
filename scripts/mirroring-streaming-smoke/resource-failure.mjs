import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from '../android-packages-smoke/host.mjs';
import { inputManifest } from '../harmony-device-smoke/evidence.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { poll } from '../device-provider/client.mjs';
import { finishPendingProbes } from '../harmony-screenshot-smoke/fixtures.mjs';
import { recordOpened, waitMedia } from './cases.mjs';
import { prepareFixture, readIfExists } from './fixtures.mjs';
import { failureLogs, observeFailureTools } from './failure-evidence.mjs';

const args = process.argv.slice(2), option = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
assert.ok(args.every(value => ['--frozen-input=', '--plugin-input=', '--tool=', '--probe=', '--case='].some(prefix => value.startsWith(prefix))));
for (const name of ['--frozen-input', '--plugin-input', '--tool', '--probe', '--case']) assert.ok(args.filter(value => value.startsWith(name + '=')).length <= 1);
const scenario = option('--case'); assert.ok(['missing-pid', 'foreign-forward'].includes(scenario));
assert.ok(option('--frozen-input') && option('--tool') && option('--probe'));
const root = fileURLToPath(new URL('../../', import.meta.url)), frozen = resolve(option('--frozen-input'));
const pluginFrozen = resolve(option('--plugin-input') ?? frozen);
const directory = join(root, 'artifacts', 'mirroring-streaming-resource-' + scenario + '-' + randomUUID()), snapshot = join(directory, 'snapshot');
await mkdir(snapshot, { recursive: true });
const report = { timestamp: new Date().toISOString(), scenario, passed: false, checks: [], opened: [], sessions: [], tools: [], requests: [],
  scope: '真实Rust宿主/投屏插件、原生fake ADB/socket、模拟远端缺PID或foreign forward身份失败和直接OS退出',
  limitations: ['保留模拟远端与forward状态不等价真实设备资源', '不证明真实ADB/scrcpy、真机、浏览器播放、进程树、分发或性能'] };
let host, observer, stage = '冻结输入';
try {
  assert.equal(process.platform, 'win32');
  const names = ['apk-server.exe', 'deviceforge-mirroring-plugin.exe', 'manifest.json', 'fake-adb.exe', 'process-probe.exe'];
  const sources = [join(frozen, names[0]), ...names.slice(1, 3).map(name => join(pluginFrozen, name)), resolve(option('--tool')), resolve(option('--probe'))];
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), sources); report.snapshots = [];
  for (let index = 0; index < names.length; index++) {
    const target = join(snapshot, names[index]); await copyFile(sources[index], target);
    const source = await fileIdentity(sources[index]), actual = await fileIdentity(target); assert.equal(actual.sha256, source.sha256); report.snapshots.push({ source, actual });
  }
  const fixture = await prepareFixture(directory, join(snapshot, 'fake-adb.exe'), { 'resource-failure': { gateShort: true } });
  const config = join(snapshot, 'mirroring.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, scrcpy: fixture.adb, adb: fixture.adb,
    live: { scrcpy_server: fixture.server, server_version: '3.3.1' } }), { flag: 'wx' });
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sessions.protocol_version, 5); assert.equal(manifest.sessions.output_retention, 'bounded_tail');
  manifest.executable = join(snapshot, 'deviceforge-mirroring-plugin.exe'); manifest.args = ['--config', config];
  host = await prepareHost({ root, binary: join(snapshot, names[0]), directory: join(directory, 'data'), report, port: await reservePort() });
  await host.ready(); const deployed = join(host.plugins, 'mirroring'); await mkdir(deployed);
  await writeFile(join(deployed, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  const loaded = await host.client.post('/api/v2/plugins/mirroring/load'); assert.equal(loaded.state, 'loaded');
  observer = observeFailureTools(fixture, join(snapshot, 'process-probe.exe'), manifest.executable, report, scenario);
  stage = '实际黄金媒体后注入模拟资源异常';
  const opened = await host.client.tool('plugin.mirroring.open', { device_id: 'resource-failure', reconnect_attempts: 0 });
  recordOpened(report, opened, report.last_request.log_id); await waitMedia(host, opened.id);
  const plan = fixture.plan('resource-failure');
  report.original_ownership = Object.fromEntries(await Promise.all(['remote-dir', 'remote-pid', 'remote-owner', 'forward-owned', 'scid'].map(async name => [name, (await readFile(join(plan, name), 'utf8'))])));
  if (scenario === 'missing-pid') await unlink(join(plan, 'remote-pid'));
  else await writeFile(join(plan, 'scid'), report.original_ownership.scid === 'ffffffff' ? 'eeeeeeee' : 'ffffffff');
  await host.client.tool('deviceforge.cancel_session', { id: opened.id });
  const ended = await poll(() => host.client.json('/api/v2/sessions/' + opened.id), info => info.status === 'finished', '失败资源会话终态');
  assert.equal(ended.completion.cleanup, 'failed'); assert.equal(ended.completion.process_exited, true);
  assert.deepEqual(await host.client.tool('deviceforge.get_session', { id: opened.id }), ended);
  report.sessions.push(ended);
  if (scenario === 'missing-pid') {
    assert.equal(await readFile(join(plan, 'remote-dir'), 'utf8'), report.original_ownership['remote-dir']);
    assert.equal(await readIfExists(join(plan, 'remote-cleaned')), null);
  } else {
    assert.equal(await readFile(join(plan, 'forward-owned'), 'utf8'), report.original_ownership['forward-owned']);
    assert.equal(await readIfExists(join(plan, 'forward-removed')), null);
    assert.equal(report.tools.filter(entry => entry.category === 'remove-forward').length, 0);
  }
  report.checks.push({ name: scenario === 'missing-pid' ? '已尝试启动但缺PID必须Failed且保留远端目录' : 'foreign forward身份不符必须Failed且不删除外来映射', passed: true });
  stage = '卸载与同ID重载保护';
  const unload = await host.client.call('/api/v2/plugins/mirroring/unload', { method: 'POST' });
  assert.equal(unload.status, 409); assert.equal(unload.body.error.code, 'cleanup_failed');
  const plugin = (await host.client.json('/api/v2/plugins')).find(value => value.id === 'mirroring');
  assert.equal(plugin.state, 'draining'); assert.equal(plugin.cleanup_failed, true);
  assert.ok(!(await host.client.tools()).includes('plugin.mirroring.open'));
  const reload = await host.client.call('/api/v2/plugins/mirroring/load', { method: 'POST' });
  assert.equal(reload.status, 409); assert.equal(reload.body.error.code, 'conflict');
  report.lifecycle = { unload: { status: unload.status, code: unload.body.error.code }, reload: { status: reload.status, code: reload.body.error?.code }, plugin };
  report.checks.push({ name: '清理失败卸载保留draining和cleanup_failed、撤销贡献且拒绝同ID重载', passed: true });
  await host.shutdown(); await observer.finish(); observer = undefined;
  await failureLogs(directory, host, report); await host.verifyIdentity();
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), sources); assert.deepEqual(report.inputs_after, report.inputs_before);
  report.checks.push({ name: '直接工具/插件实际退出与未确认远端资源分离、宿主exit0和端口释放', passed: true });
  report.passed = true;
} catch (error) { report.failure = { stage, name: error.name, message: error.message, stack: error.stack, ...(error.session ? { session: error.session } : {}) }; }
finally {
  if (host) { try { await host.finish(); } catch (error) { report.passed = false; report.cleanup_failure = error.message; } }
  if (observer) await observer.stop();
  try { await finishPendingProbes(report); } catch (error) { report.passed = false; report.probe_failure = error.message; }
  report.completed_at = new Date().toISOString(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, tools: report.tools.length, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
