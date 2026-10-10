import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { catalog, missingAdb } from './android-device-smoke/bootstrap.mjs';
import { noFallback, preciseErrors, sevenCapabilities, sharedLocks } from './android-device-smoke/actions.mjs';
import { prepareDeployment, publishAndValidate, verifyDeployment } from './android-device-smoke/deployment.mjs';
import { discoveryEntries, malformedDiscovery } from './android-device-smoke/discovery.mjs';
import { artifactBusiness, preserveArtifacts } from './android-device-smoke/artifacts.mjs';
import { apksBusiness } from './android-device-smoke/apks.mjs';
import { configureAdb, prepareTool } from './android-device-smoke/fixtures.mjs';
import { lifecycle, owner, plugins } from './android-device-smoke/lifecycle.mjs';
import { preserveHistory, verifyInventory } from './android-device-smoke/jobs.mjs';
import { failure, inputManifest, reportFor, retain, verifyLogs, writeReport } from './android-device-smoke/evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), entry = fileURLToPath(import.meta.url);
let profile = 'debug', toolBinary, sourceDirectory, performanceMode = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--release') { assert.equal(profile, 'debug', '--release不可重复'); profile = 'release'; }
  else if (args[index] === '--performance') { assert.equal(performanceMode, false, '--performance不可重复'); performanceMode = true; }
  else if (args[index] === '--tool-binary') {
    assert.equal(toolBinary, undefined, '--tool-binary不可重复'); toolBinary = args[++index];
    assert.ok(toolBinary && isAbsolute(toolBinary), '--tool-binary必须为本独立假ADB绝对路径');
  } else if (args[index] === '--source-directory') {
    assert.equal(sourceDirectory, undefined, '--source-directory不可重复'); sourceDirectory = args[++index];
    assert.ok(sourceDirectory && isAbsolute(sourceDirectory), '--source-directory必须为冻结源元数据目录绝对路径');
  } else assert.fail('仅支持--release、--performance、--tool-binary和--source-directory');
}
assert.ok(!performanceMode || sourceDirectory === undefined, '--performance必须读取当前性能清单，不可混用旧源快照');
assert.ok(toolBinary, '主代理先用rustc编译scripts/android-device-smoke/fake-adb.rs，再显式传入--tool-binary');
const binary = resolve(root, 'backend/target', profile, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server');
const report = reportFor(profile);
if (performanceMode) {
  report.performance_mode = true;
  report.scope += '；当前性能模式十二贡献/十一能力/九device能力、五笔采样、动态默认源和会话历史';
  report.limitations.push('性能假ADB数值为独立合成夹具，不证明真机CPU/PSS/RSS准确性、FPS或尾延迟',
    '采样空有效产物权限、异常outputs、预取消/截止点和慢存储/粘性清理门禁由专项协议与应用测试另证',
    '未配置来源与旧API1 demo兼容由对应runtime另证；本模式使用显式android-device默认源');
}
let directory, deployment, fixture, host, inputs;

try {
  report.stage = '独立输入与已有binary冻结';
  const source = sourceDirectory ?? join(root, 'backend/plugins/android-device');
  const additional = [binary, process.execPath, toolBinary, join(root, 'scripts/android-device-smoke/fake-adb.rs'),
    ...['package.json', 'manifest.json', 'manifest.example.json', 'aliases.example.json', 'README.md'].map((name) => join(source, name)),
    ...['deviceforge-android-device-plugin', 'validate-plugin'].map((name) => join(root, 'backend/target', profile, name + (process.platform === 'win32' ? '.exe' : '')))];
  if (performanceMode) {
    const performanceInputs = await inputManifest(join(root, 'scripts/android-device-smoke/performance.mjs'), []);
    additional.push(...performanceInputs.map(item => item.path));
  }
  inputs = additional; report.inputs_before = await inputManifest(entry, inputs);
  directory = await mkdtemp(join(tmpdir(), 'deviceforge-android-device-')); report.temporary_root = directory;
  deployment = await prepareDeployment({ root, directory, profile, report, source, performance: performanceMode });
  fixture = await prepareTool(directory, toolBinary, report);
  report.stage = '新宿主空数据、十一旧名无内置回退';
  host = await prepareHost({ root, binary, directory: join(directory, 'data'), bindingsPath: deployment.bindingsPath, report, port: await reservePort(),
    ...(performanceMode ? { performancePlugin: 'android-device' } : {}) });
  await host.ready(); await plugins(host); await catalog(host, deployment, report, '无插件', false);
  await noFallback(host, fixture, report, '新宿主无插件');
  report.stage = performanceMode ? '当前性能portable、真实validator与十二贡献十一能力' : '发布原portable、真实validator与十一贡献十能力';
  await publishAndValidate(deployment, report);
  const loaded = owner(await host.client.post('/api/v2/plugins/android-device/load'), deployment, undefined, 'loaded');
  report.generations = { first: loaded.generation };
  await plugins(host, loaded); await catalog(host, deployment, report, '首次加载', true, loaded);
  report.stage = '合法空产物上下文与未配ADB精确业务失败';
  await missingAdb(host, report);
  report.stage = '部署者旁置假ADB配置及未观测准入';
  await configureAdb(deployment, fixture, report); await preciseErrors(host, fixture, report, { beforeDiscovery: true });
  report.stage = '三类发现HTTP/MCP各一Job/一工具';
  await discoveryEntries(host, deployment, fixture, report);
  await malformedDiscovery(host, deployment, fixture, report);
  report.stage = '九能力业务、旧alias与精确准入拒绝';
  await preciseErrors(host, fixture, report); await sevenCapabilities(host, fixture, report);
  report.stage = '安装截图公开产物、锁、取消与实体历史';
  await artifactBusiness(host, fixture, report);
  await preserveArtifacts(host, fixture, report, '产物业务完成');
  report.stage = 'APKS公开能力/直接贡献/旧alias、Java资格、私有副本与跨动作写锁';
  await apksBusiness(host, fixture, report);
  await preserveArtifacts(host, fixture, report, 'APKS业务完成');
  report.stage = '真实门闩与跨入口共享锁';
  await sharedLocks(host, fixture, report);
  report.stage = '在途卸载、产物历史、旧代拒绝与新代重载';
  await lifecycle(host, deployment, fixture, report); host.assertRunning();
  await preserveArtifacts(host, fixture, report, '卸载与重载后');
  await verifyInventory(host, fixture, report);
  if (performanceMode) {
    report.apks_inventory = structuredClone(report.inventory);
    report.stage = '性能独立五笔样本、read真实边界、八会话及动态来源生命周期';
    const { performanceBusiness } = await import('./android-device-smoke/performance.mjs');
    await performanceBusiness(host, deployment, fixture, report);
    const { verifyPerformanceInventory } = await import('./android-device-smoke/jobs.mjs');
    await verifyPerformanceInventory(host, fixture, report);
    await preserveHistory(host, report, '性能最终卸载后');
    await preserveArtifacts(host, fixture, report, '性能会话及最终卸载后');
  }
  report.stage = '正常退出、端口释放、逐Job关联日志与输入身份';
  await host.shutdown(); await verifyLogs(directory, host, report); await host.verifyIdentity();
  await verifyDeployment(deployment, report);
  report.checks.push({ name: '真实宿主正常exit0、端口释放、HTTP/MCP日志和逐Job插件关联', passed: true });
  report.stage = '完成'; report.passed = true;
} catch (error) { failure(report, error); process.exitCode = 1; }
finally {
  if (host) {
    try { await host.finish(); }
    catch (error) { failure(report, error, '自有宿主退出与端口释放'); process.exitCode = 1; }
  }
  if (inputs) {
    try {
      report.inputs_after = await inputManifest(entry, inputs);
      report.inputs_stable = JSON.stringify(report.inputs_before) === JSON.stringify(report.inputs_after);
      assert.equal(report.inputs_stable, true, '冻结输入前后必须原字节一致');
    } catch (error) { failure(report, error, '冻结输入前后复核'); process.exitCode = 1; }
  }
  report.shutdown_attempts = report.requests.filter((request) => request.path === '/api/v2/system/shutdown');
  if (directory) {
    try { await retain(directory, report); }
    catch (error) { failure(report, error, '保留原件索引'); report.temporary_retained = directory; process.exitCode = 1; }
  }
  if (!report.passed) process.exitCode = 1;
  const reportPath = await writeReport(root, report);
  console.log(JSON.stringify({ passed: report.passed, report: reportPath, stage: report.failure_stage ?? report.stage,
    case_id: report.failure_case_id, error: report.error }));
}
