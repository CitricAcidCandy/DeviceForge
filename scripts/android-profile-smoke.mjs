import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity, inputManifest, retain, writeJsonBatches } from './android-device-observation-smoke/evidence.mjs';
import { verifyLogs } from './android-device-smoke/evidence.mjs';
import { failure } from './android-game-fps-smoke/evidence.mjs';
import { prepareFixture, verifyFixture } from './android-profile-smoke/fixtures.mjs';
import { probeBusiness, probeContract } from './android-profile-smoke/probe-cases.mjs';
import { finishPendingProbes, observeTools } from './android-profile-smoke/processes.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Android Root/profile 独立功能验收，当前仅冻结probe阶段，不执行性能压测');
  console.log('node scripts/android-profile-smoke.mjs --phase=probe --frozen-input=宿主冻结目录 --plugin-input=插件冻结目录 --tool=原生假ADB路径 --probe=OS探针路径 [--profile=debug|release]');
  console.log('record及连续媒体阶段尚待冻结；本入口不构建、不同步生成类型。'); process.exit(0);
}
const names = ['--phase', '--frozen-input', '--plugin-input', '--tool', '--probe', '--profile'];
assert.ok(args.every(value => names.some(name => value.startsWith(name + '='))), 'PROFILE-UNKNOWN-ARGUMENT');
for (const name of names) assert.ok(args.filter(value => value.startsWith(name + '=')).length <= 1, 'PROFILE-DUPLICATE-ARGUMENT');
const option = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
for (const name of names.slice(0, 5)) assert.ok(option(name), 'PROFILE-EXPLICIT-FROZEN-INPUT-REQUIRED');
assert.equal(option('--phase'), 'probe', 'PROFILE-UNFROZEN-PHASE');
const profile = option('--profile') ?? 'debug'; assert.ok(['debug', 'release'].includes(profile));
const root = fileURLToPath(new URL('../', import.meta.url));
const frozen = resolve(option('--frozen-input')), pluginFrozen = resolve(option('--plugin-input'));
assert.equal(probeContract.frozen, true, 'PROFILE-PROBE-ROUTE-FROZEN');
const directory = join(root, 'artifacts', 'android-profile-probe-service-' + profile + '-' + randomUUID());
const snapshot = join(directory, 'snapshot'); await mkdir(snapshot, { recursive: true });
const report = { timestamp: new Date().toISOString(), phase: 'probe', profile, passed: false, checks: [], requests: [], jobs: [], tools: [], history: [],
  scope: '新冻结宿主/Android插件、原生假ADB精确Root资格、HTTP/MCP动态贡献、共享Job稳定历史与原OS句柄',
  limitations: ['资格黄金不是Root真机、su方言/OEM或实际simpleperf证明', '本阶段不执行record/remote进程/连续媒体或真实画面',
    '原OS句柄仅为直接工具及父插件，不证明派生树或远端进程', '便携冻结目录不是正式TGZ/npx或另一LAN主机证据',
    '功能验收不提供容量、压测、采集开销或性能结论'] };
let host, observer, fixture, stage = '冻结probe输入';
const binaryNames = ['apk-server.exe', 'deviceforge-android-device-plugin.exe', 'manifest.json', 'fake-adb.exe', 'process-probe.exe'];
const sources = [join(frozen, binaryNames[0]), join(pluginFrozen, binaryNames[1]), join(pluginFrozen, binaryNames[2]), resolve(option('--tool')), resolve(option('--probe'))];
try {
  assert.equal(process.platform, 'win32', 'PROFILE-WINDOWS-OS-HANDLE');
  const inputs = [...sources, join(root, 'scripts/android-profile-smoke/fake-adb.rs')];
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), inputs); report.snapshots = [];
  for (let index = 0; index < sources.length; index++) {
    const source = await fileIdentity(sources[index]), target = join(snapshot, binaryNames[index]);
    await copyFile(sources[index], target); const actual = await fileIdentity(target);
    assert.equal(actual.sha256, source.sha256); assert.equal(actual.bytes, source.bytes); report.snapshots.push({ source, actual });
  }
  fixture = await prepareFixture(directory, join(snapshot, 'fake-adb.exe'), probeContract, report);
  const config = join(snapshot, 'android-device.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, tools: { adb: fixture.adb }, profile: probeContract.config }), { flag: 'wx' });
  report.config = await fileIdentity(config);
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'android-device'); assert.equal(manifest.protocol_version, 4);
  assert.ok(manifest.operations.some(item => item.name === 'stack.probe'), 'PROFILE-PROBE-MANIFEST-CONTRIBUTION');
  manifest.executable = join(snapshot, 'deviceforge-android-device-plugin.exe');
  host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'), directory: join(directory, 'data'), report, port: await reservePort() });
  await host.ready(); host.assertRunning();
  assert.ok(!(await host.client.tools()).includes('android-device.stack.probe'), 'PROFILE-PROBE-INITIAL-ABSENT');
  const deployment = join(host.plugins, 'android-device'); await mkdir(deployment);
  const deployedManifest = join(deployment, 'manifest.json'); await writeFile(deployedManifest, JSON.stringify(manifest), { flag: 'wx' });
  report.deployed_manifest = await fileIdentity(deployedManifest);
  observer = observeTools(fixture, join(snapshot, 'process-probe.exe'), manifest.executable, report);
  const loaded = await host.client.post('/api/v2/plugins/android-device/load'); assert.equal(loaded.state, 'loaded');
  stage = 'Root资格共享Job、动态贡献与稳定历史';
  await probeBusiness(host, fixture, observer, loaded, report); observer.assertHealthy(); host.assertRunning();
  stage = '正常退出与原OS句柄'; await host.shutdown(); await observer.finish(); observer = undefined; await host.verifyIdentity();
  stage = '日志及冻结身份'; await verifyLogs(directory, host, report);
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), inputs); assert.deepEqual(report.inputs_after, report.inputs_before);
  for (const item of report.snapshots) assert.deepEqual(await fileIdentity(item.actual.path), item.actual);
  await verifyFixture(fixture, report); assert.deepEqual(await fileIdentity(config), report.config);
  assert.deepEqual(await fileIdentity(deployedManifest), report.deployed_manifest);
  report.checks.push({ name: '原OS退出码与冻结拒绝计划一致、宿主正常退出/端口释放、日志及输入身份稳定', passed: true }); report.passed = true;
} catch (error) { failure(report, error, stage); }
finally {
  if (host) { try { await host.finish(); } catch (error) { failure(report, error, '收口自有宿主'); } }
  if (observer) { try { await observer.stop(); } catch (error) { failure(report, error, '停止工具观察器'); } }
  try { await finishPendingProbes(report); } catch (error) { failure(report, error, '收口原句柄探针'); }
  report.completed_at = new Date().toISOString();
  try { await retain(directory, report); } catch (error) { failure(report, error, '有界保留原件'); }
  await writeJsonBatches(join(directory, 'report.json'), report);
  console.log(JSON.stringify({ directory, passed: report.passed, phase: report.phase, checks: report.checks.length, jobs: report.jobs.length, tools: report.tools.length }));
  process.exitCode = report.passed ? 0 : 1;
}
