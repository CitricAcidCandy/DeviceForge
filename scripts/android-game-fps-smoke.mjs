import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { business } from './android-game-fps-smoke/cases.mjs';
import { fileIdentity, inputManifest, retain, writeJsonBatches } from './android-device-observation-smoke/evidence.mjs';
import { failure, verifyLogs } from './android-game-fps-smoke/evidence.mjs';
import { actualFrontend, freezeFrontend, verifyFrontend } from './android-device-observation-smoke/frontend.mjs';
import { prepareFixture, verifyFixture } from './android-game-fps-smoke/fixtures.mjs';
import { contract } from './android-game-fps-smoke/route.mjs';
import { finishPendingProbes, observeTools } from './android-device-observation-smoke/processes.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Android游戏FPS功能验收（固定SF原字节，不执行性能压测）');
  console.log('node scripts/android-game-fps-smoke.mjs --frozen-input=宿主冻结目录 --plugin-input=插件冻结目录 --tool=原生假ADB路径 --probe=OS探针路径 [--profile=debug|release]');
  console.log('冻结宿主目录必须含apk-server.exe，插件目录必须含deviceforge-android-device-plugin.exe和manifest.json。');
  process.exit(0);
}
const names = ['--frozen-input', '--plugin-input', '--tool', '--probe', '--profile'];
assert.ok(args.every(value => names.some(name => value.startsWith(name + '='))), 'FPS-UNKNOWN-ARGUMENT');
for (const name of names) assert.ok(args.filter(value => value.startsWith(name + '=')).length <= 1, 'FPS-DUPLICATE-ARGUMENT');
const option = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
for (const name of names.slice(0, 4)) assert.ok(option(name), 'FPS-EXPLICIT-FROZEN-INPUT-REQUIRED');
const profile = option('--profile') ?? 'debug'; assert.ok(['debug', 'release'].includes(profile), 'FPS-PROFILE');
const root = fileURLToPath(new URL('../', import.meta.url));
const frozen = resolve(option('--frozen-input')), pluginFrozen = resolve(option('--plugin-input'));
assert.equal(contract.frozen, true, 'FPS-OFFICIAL-ROUTE-NOT-FROZEN');
const directory = join(root, 'artifacts', 'android-game-fps-service-' + profile + '-' + randomUUID());
const snapshot = join(directory, 'snapshot'); await mkdir(snapshot, { recursive: true });
const report = { timestamp: new Date().toISOString(), profile, passed: false, checks: [], requests: [], jobs: [], sessions: [], tools: [], history: [],
  scope: '新冻结Rust宿主/Android插件、原生假ADB的冻结AOSP路由原字节、游戏FPS归属及展示窗口、HTTP/MCP和实际前端工厂历史热装卸',
  limitations: ['黄金文本不是实际设备测量，不证明真实游戏准确性、OEM兼容或商业采集工具等价',
    '帧时间戳及PID/UID归属为合成黄金输入，不证明真实Android/OEM与实际游戏准确性',
    '实际前端模块运行于Node，无产品页面、浏览器绘图或视觉验收',
    '仅观察本次直接工具及父插件原OS句柄，不证明派生进程树或远端设备资源',
    '便携冻结目录不是正式TGZ/npx、registry、跨平台或局域网另一主机证据',
    '功能采样不提供生产容量、压力、采集开销或性能优化结论'] };
let host, observer, frontend, fixture, stage = '冻结输入';
const binaryNames = ['apk-server.exe', 'deviceforge-android-device-plugin.exe', 'manifest.json', 'fake-adb.exe', 'process-probe.exe'];
const sources = [join(frozen, binaryNames[0]), join(pluginFrozen, binaryNames[1]), join(pluginFrozen, binaryNames[2]), resolve(option('--tool')), resolve(option('--probe'))];
try {
  assert.equal(process.platform, 'win32', 'FPS-WINDOWS-OS-HANDLE-FIXTURE');
  const frontendRoot = await freezeFrontend(root, join(snapshot, 'frontend'), report);
  const inputPaths = [...sources, join(root, 'scripts/android-game-fps-smoke/fake-adb.rs'), ...report.frontend_snapshots.map(entry => entry.source.path)];
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), inputPaths);
  report.snapshots = [];
  for (let index = 0; index < sources.length; index++) {
    const source = await fileIdentity(sources[index]), target = join(snapshot, binaryNames[index]);
    await copyFile(sources[index], target); const actual = await fileIdentity(target);
    assert.equal(actual.sha256, source.sha256, 'FPS-SNAPSHOT-SHA'); assert.equal(actual.bytes, source.bytes);
    report.snapshots.push({ source, actual });
  }
  fixture = await prepareFixture(directory, join(snapshot, 'fake-adb.exe'), contract, report);
  const config = join(snapshot, 'android-device.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, tools: { adb: fixture.adb } }), { flag: 'wx' });
  report.config = await fileIdentity(config);
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'android-device', 'FPS-MANIFEST-ID');
  assert.equal(manifest.protocol_version, 4, 'FPS-MANIFEST-PROTOCOL');
  assert.equal(manifest.performance?.api_version, 2, 'FPS-MANIFEST-PERFORMANCE-VERSION');
  assert.equal(manifest.performance.fps, true, 'FPS-MANIFEST-FPS');
  assert.ok(Array.isArray(manifest.args), 'FPS-MANIFEST-ARGS');
  manifest.executable = join(snapshot, 'deviceforge-android-device-plugin.exe');
  host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'), directory: join(directory, 'data'), report,
    port: await reservePort(), performancePlugin: 'android-device' });
  await host.ready(); host.assertRunning();
  assert.ok(!(await host.client.tools()).includes('plugin.android-device.performance.sample'), 'FPS-INITIAL-TOOL-ABSENT');
  const deployment = join(host.plugins, 'android-device'); await mkdir(deployment);
  const deployedManifest = join(deployment, 'manifest.json'); await writeFile(deployedManifest, JSON.stringify(manifest), { flag: 'wx' });
  report.deployed_manifest = await fileIdentity(deployedManifest);
  observer = observeTools(fixture, join(snapshot, 'process-probe.exe'), manifest.executable, report);
  const loaded = await host.client.post('/api/v2/plugins/android-device/load'); assert.equal(loaded.state, 'loaded');
  assert.ok((await host.client.tools()).includes('plugin.android-device.performance.sample'), 'FPS-LOADED-TOOL-PRESENT');
  frontend = await actualFrontend(host, report, frontendRoot);
  stage = 'FPS归属、展示窗口与实际前端历史';
  await business(host, fixture, observer, frontend, loaded, report); observer.assertHealthy(); host.assertRunning();
  frontend.dispose(); frontend = undefined;
  stage = '正常退出与原OS句柄';
  await host.shutdown(); await observer.finish(); observer = undefined;
  await host.verifyIdentity();
  stage = '日志关联及冻结身份';
  await verifyLogs(directory, host, report); await verifyFrontend(report);
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), inputPaths);
  assert.deepEqual(report.inputs_after, report.inputs_before, 'FPS-INPUTS-STABLE');
  for (const entry of report.snapshots) assert.deepEqual(await fileIdentity(entry.actual.path), entry.actual, 'FPS-SNAPSHOT-STABLE');
  await verifyFixture(fixture, report);
  assert.deepEqual(await fileIdentity(config), report.config, 'FPS-CONFIG-STABLE');
  assert.deepEqual(await fileIdentity(deployedManifest), report.deployed_manifest, 'FPS-DEPLOYED-MANIFEST-STABLE');
  report.checks.push({ name: '所有直接工具/插件原句柄已退出、宿主exit0、监听释放及新冻结字节身份稳定', passed: true });
  report.passed = true;
} catch (error) { failure(report, error, stage); }
finally {
  try { frontend?.dispose(); } catch (error) { failure(report, error, '释放实际前端'); }
  if (host) { try { await host.finish(); } catch (error) { failure(report, error, '收口自有宿主'); } }
  if (observer) { try { await observer.stop(); } catch (error) { failure(report, error, '停止工具观察器'); } }
  try { await finishPendingProbes(report); } catch (error) { failure(report, error, '收口原句柄探针'); }
  report.completed_at = new Date().toISOString();
  try { await retain(directory, report); } catch (error) { failure(report, error, '有界保留原件'); }
  await writeJsonBatches(join(directory, 'report.json'), report);
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, sessions: report.sessions.length, tools: report.tools.length }));
  process.exitCode = report.passed ? 0 : 1;
}
