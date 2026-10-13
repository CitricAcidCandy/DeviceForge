import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { inputManifest } from './harmony-device-smoke/evidence.mjs';
import { verifyLogs } from './terminal-interactive-smoke/evidence.mjs';
import { assertGoldenFrames, finished, readFrontend, recordOpened, sendFrontendControls, waitMedia } from './mirroring-streaming-smoke/cases.mjs';
import { actualFrontend } from './mirroring-streaming-smoke/frontend.mjs';
import { assertClean, connected, controlObserved, prepareFixture, readIfExists } from './mirroring-streaming-smoke/fixtures.mjs';
import { controlGolden, keyControl } from './mirroring-streaming-smoke/golden.mjs';
import { finishPendingProbes, observeTools } from './mirroring-streaming-smoke/processes.mjs';

const argumentsList = process.argv.slice(2), option = name => argumentsList.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
assert.ok(argumentsList.every(value => ['--frozen-input=', '--plugin-input=', '--tool=', '--probe=', '--profile='].some(prefix => value.startsWith(prefix))));
for (const name of ['--frozen-input', '--plugin-input', '--tool', '--probe', '--profile']) assert.ok(argumentsList.filter(value => value.startsWith(name + '=')).length <= 1);
assert.ok(option('--frozen-input') && option('--tool') && option('--probe'), '必须指定主代理冻结输入、原生夹具和 OS 探针');
const root = fileURLToPath(new URL('../', import.meta.url)), frozen = resolve(option('--frozen-input'));
const pluginFrozen = resolve(option('--plugin-input') ?? frozen);
const profile = option('--profile') ?? 'debug'; assert.ok(['debug', 'release'].includes(profile));
const directory = join(root, 'artifacts', `mirroring-streaming-service-${profile}-${randomUUID()}`), snapshot = join(directory, 'snapshot');
await mkdir(snapshot, { recursive: true });
const report = { timestamp: new Date().toISOString(), profile, passed: false, checks: [], sessions: [], opened: [], tools: [], requests: [],
  scope: '真实冻结Rust宿主/独立投屏插件、实际前端工厂、HTTP/MCP、原生fake ADB/scrcpy TCP及真实直接进程退出',
  limitations: ['合成H264与PCM只证明协议传输，未证明真实编码、完整解码或播放效果', '远端PID/目录/forward为持久模拟，不等价真机资源回收',
    '本机直接OS句柄不证明派生树、跨平台或局域网另一主机', '未执行真实scrcpy/ADB、真机、浏览器播放、正式包分发或性能测试'] };
let host, observer, frontend, stage = '冻结输入';
const copied = [];
try {
  assert.equal(process.platform, 'win32');
  const names = ['apk-server.exe', 'deviceforge-mirroring-plugin.exe', 'manifest.json', 'fake-adb.exe', 'process-probe.exe'];
  const sources = [join(frozen, names[0]), ...names.slice(1, 3).map(name => join(pluginFrozen, name)), resolve(option('--tool')), resolve(option('--probe'))];
  const frontendEntry = join(root, 'frontend/src/features/mirroring-streaming/index.ts');
  const frontendClientEntry = join(root, 'frontend/src/shared/api/client.ts');
  const frontendManifests = await Promise.all([inputManifest(frontendEntry, []), inputManifest(frontendClientEntry, [])]);
  report.frontend_before = [...new Map(frontendManifests.flat().map(entry => [entry.path, entry])).values()].sort((left, right) => left.path.localeCompare(right.path));
  report.frontend_snapshots = [];
  for (const entry of report.frontend_before) {
    const target = join(snapshot, relative(root, entry.path)); await mkdir(dirname(target), { recursive: true }); await copyFile(entry.path, target);
    const actual = await fileIdentity(target); assert.equal(actual.sha256, entry.sha256); report.frontend_snapshots.push({ source: entry, actual });
  }
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), [...sources, ...report.frontend_before.map(entry => entry.path)]);
  for (let index = 0; index < names.length; index++) {
    const target = join(snapshot, names[index]); await copyFile(sources[index], target);
    const source = await fileIdentity(sources[index]), actual = await fileIdentity(target); assert.equal(actual.sha256, source.sha256); copied.push({ source, actual });
  }
  report.snapshots = copied;
  const fixture = await prepareFixture(directory, join(snapshot, 'fake-adb.exe'), {
    'http-control': { gateShort: true }, 'mcp-unload': { gateShort: true },
    reconnect: { gateShort: true, disconnectFirst: true }, shutdown: { gateShort: true },
  });
  const config = join(snapshot, 'mirroring.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, scrcpy: fixture.adb, adb: fixture.adb,
    live: { scrcpy_server: fixture.server, server_version: '3.3.1' } }), { flag: 'wx' });
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sessions?.protocol_version, 5); assert.equal(manifest.sessions.output_retention, 'bounded_tail');
  assert.equal(manifest.sessions.operations.length, 1); assert.equal(manifest.sessions.operations[0].name, 'open');
  manifest.executable = join(snapshot, 'deviceforge-mirroring-plugin.exe'); manifest.args = ['--config', config];
  host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'), directory: join(directory, 'data'), report, port: await reservePort() });
  await host.ready();
  assert.ok(!(await host.client.tools()).includes('plugin.mirroring.open'));
  const deployment = join(host.plugins, 'mirroring'); await mkdir(deployment);
  await writeFile(join(deployment, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  const loaded = await host.client.post('/api/v2/plugins/mirroring/load');
  assert.equal(loaded.state, 'loaded'); assert.deepEqual(loaded.sessions, ['plugin.mirroring.open']);
  observer = observeTools(fixture, join(snapshot, 'process-probe.exe'), manifest.executable, report);
  const actual = await actualFrontend(host, report, join(snapshot, 'frontend')); frontend = actual.frontend;
  await frontend.refreshDefinitions(AbortSignal.timeout(10000));
  assert.deepEqual(await host.client.tool('deviceforge.list_session_definitions', {}), await host.client.json('/api/v2/session-definitions'));
  report.checks.push({ name: '协议4录像与协议5直播独立注册、HTTP/MCP目录一致', passed: true });

  stage = '实际前端视频音频和控制';
  const opened = await frontend.open({ device_id: 'http-control', audio: true, control: true, reconnect_attempts: 0 }, AbortSignal.timeout(10000));
  recordOpened(report, opened.data, opened.logId);
  await readFrontend(frontend, actual.packets);
  const raw = await waitMedia(host, opened.data.id); assertGoldenFrames(raw.frames);
  await sendFrontendControls(frontend, fixture, 'http-control');
  const cursor = frontend.snapshot().cursor, controls = await readFile(join(await connected(fixture, 'http-control'), 'control.bin'));
  const requestCount = report.requests.filter(request => request.path === '/api/v2/sessions' && request.method === 'POST').length;
  await frontend.resume(opened.data.id, AbortSignal.timeout(10000));
  await frontend.readOutput({ limit: 100 }, AbortSignal.timeout(10000));
  assert.ok(frontend.snapshot().cursor >= cursor);
  assert.equal(report.requests.filter(request => request.path === '/api/v2/sessions' && request.method === 'POST').length, requestCount);
  assert.deepEqual(await readFile(join(await connected(fixture, 'http-control'), 'control.bin')), controls);
  const eof = await frontend.eof(AbortSignal.timeout(10000)); assert.equal(eof.data.accepted, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await host.client.json(`/api/v2/sessions/${opened.data.id}`)).status, 'running');
  assert.equal(await readIfExists(join(await connected(fixture, 'http-control'), 'peer-closed')), null);
  await frontend.cancel(AbortSignal.timeout(10000));
  await finished(host, fixture, opened.data, 'http-control', report, '实际前端取消', observer);
  report.checks.push({ name: '实际前端H264/PCM原字节、控制生效、恢复无重放、EOF保留媒体与取消清理', passed: true });

  stage = 'MCP控制及卸载';
  const mcp = await host.client.tool('plugin.mirroring.open', { device_id: 'mcp-unload', reconnect_attempts: 0 });
  recordOpened(report, mcp, report.last_request.log_id);
  assertGoldenFrames((await waitMedia(host, mcp.id)).frames);
  for (const input of [{ type: 'key', action: 'down', keycode: 3 }, { type: 'key', action: 'up', keycode: 3 },
    { type: 'text', text: '你好🌍' }, { type: 'touch', action: 'down', pointer_id: 1, x: 17, y: 23, width: 1280, height: 720, pressure: 1 }]) {
    const bytes = Buffer.from(JSON.stringify({ ...input, epoch: 1 }) + '\n');
    const first = Math.max(1, bytes.length - 8);
    for (const piece of [bytes.subarray(0, first), bytes.subarray(first, first + 3), bytes.subarray(first + 3)]) {
      await host.client.tool('deviceforge.session_input', { id: mcp.id, bytes: [...piece] });
    }
  }
  await controlObserved(await connected(fixture, 'mcp-unload'), controlGolden);
  const unloaded = await host.client.post('/api/v2/plugins/mirroring/unload'); assert.equal(unloaded.state, 'unloaded');
  await finished(host, fixture, mcp, 'mcp-unload', report, '在途卸载', observer);
  assert.ok(!(await host.client.tools()).includes('plugin.mirroring.open'));
  const rejection = await host.client.call(`/api/v2/sessions/${mcp.id}/input`, { method: 'POST', body: JSON.stringify({ bytes: [1] }) });
  assert.equal(rejection.status, 409); assert.ok(rejection.body.error?.code);
  const reloaded = await host.client.tool('deviceforge.load_plugin', { id: 'mirroring' }); assert.notEqual(reloaded.generation, loaded.generation);
  assert.equal((await host.client.json(`/api/v2/sessions/${mcp.id}`)).generation, loaded.generation);
  report.checks.push({ name: 'MCP三路原字节、卸载取消/目录撤销、旧代拒绝及新代保留历史', passed: true });

  stage = '设备断线重连';
  const reconnect = await host.client.tool('plugin.mirroring.open', { device_id: 'reconnect', reconnect_attempts: 1 });
  recordOpened(report, reconnect, report.last_request.log_id);
  const second = await waitMedia(host, reconnect.id, 2); assertGoldenFrames(second.frames, 1); assertGoldenFrames(second.frames, 2);
  const epoch2 = await connected(fixture, 'reconnect', 2); assert.equal(await readIfExists(join(epoch2, 'control.bin')), null);
  await host.client.tool('deviceforge.session_input', { id: reconnect.id, bytes: [...Buffer.from(JSON.stringify({ type: 'key', action: 'down', keycode: 3, epoch: 2 }) + '\n')] });
  await controlObserved(epoch2, keyControl(0, 3));
  await host.client.tool('deviceforge.session_input', { id: reconnect.id,
    bytes: [...Buffer.from(JSON.stringify({ type: 'key', action: 'up', keycode: 3, epoch: 1 }) + '\n')] });
  const stale = await finished(host, fixture, reconnect, 'reconnect', report, '旧连接epoch输入拒绝', observer);
  assert.match(stale.completion.outcome.error, /代次/);
  assert.deepEqual(await readFile(join(epoch2, 'control.bin')), keyControl(0, 3));
  report.checks.push({ name: '首连接断线、epoch2重连无控制重放、当前代执行及旧epoch零字节拒绝', passed: true });

  stage = '宿主关闭';
  const shutdown = await host.client.tool('plugin.mirroring.open', { device_id: 'shutdown', reconnect_attempts: 0 });
  recordOpened(report, shutdown, report.last_request.log_id); await waitMedia(host, shutdown.id);
  await host.shutdown();
  await assertClean(fixture, 'shutdown');
  await observer.finish(); observer = undefined;
  await host.verifyIdentity();
  await verifyLogs(directory, host, report); report.checks.at(-1).name = '全部响应日志ID及本轮直播准入结束关联落盘';
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), [...sources, ...report.frontend_before.map(entry => entry.path)]);
  assert.deepEqual(report.inputs_after, report.inputs_before);
  report.frontend_after = await Promise.all(report.frontend_before.map(entry => fileIdentity(entry.path))); assert.deepEqual(report.frontend_after, report.frontend_before);
  report.frontend_snapshots_after = await Promise.all(report.frontend_snapshots.map(entry => fileIdentity(entry.actual.path)));
  assert.deepEqual(report.frontend_snapshots_after, report.frontend_snapshots.map(entry => entry.actual));
  report.checks.push({ name: '全部直接工具/插件实际退出、宿主exit0、监听释放和输入稳定', passed: true }); report.passed = true;
} catch (error) { report.failure = { stage, name: error.name, message: error.message, stack: error.stack, ...(error.session ? { session: error.session } : {}) }; }
finally {
  frontend?.dispose();
  if (host) { try { await host.finish(); } catch (error) { report.passed = false; report.cleanup_failure = { name: error.name, message: error.message }; } }
  if (observer) { try { await observer.stop(); } catch (error) { report.passed = false; report.observer_failure = error.message; } }
  try { await finishPendingProbes(report); } catch (error) { report.passed = false; report.probe_failure = error.message; }
  report.completed_at = new Date().toISOString(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, tools: report.tools.length, sessions: report.opened.length, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
