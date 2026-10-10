import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { catalog, missingHdc } from './harmony-device-smoke/bootstrap.mjs';
import { noFallback, preciseErrors, ordinaryBusiness } from './harmony-device-smoke/actions.mjs';
import { prepareDeployment, publishAndValidate, verifyDeployment } from './harmony-device-smoke/deployment.mjs';
import { discoveryEntries, malformedDiscovery } from './harmony-device-smoke/discovery.mjs';
import { upload, installBusiness, sharedLocks, cancellation, preserveSource } from './harmony-device-smoke/artifacts.mjs';
import { configureHdc, prepareTool } from './harmony-device-smoke/fixtures.mjs';
import { lifecycle, owner, plugins } from './harmony-device-smoke/lifecycle.mjs';
import { failure, inputManifest, reportFor, retain, verifyLogs, writeReport } from './harmony-device-smoke/evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), entry = fileURLToPath(import.meta.url);
let profile = 'debug', toolBinary, sourceDirectory;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--release') { assert.equal(profile, 'debug', '--release不可重复'); profile = 'release'; }
  else if (args[index] === '--tool-binary') {
    assert.equal(toolBinary, undefined, '--tool-binary不可重复'); toolBinary = args[++index]; assert.ok(toolBinary && isAbsolute(toolBinary), '--tool-binary须为独立假HDC绝对路径');
  } else if (args[index] === '--source-directory') {
    assert.equal(sourceDirectory, undefined, '--source-directory不可重复'); sourceDirectory = args[++index];
    assert.ok(sourceDirectory && isAbsolute(sourceDirectory), '--source-directory须为冻结源元数据绝对路径');
  } else assert.fail('仅支持--release、--tool-binary及--source-directory');
}
assert.ok(toolBinary, '主代理先编译本目录fake-hdc.rs，再传入--tool-binary');
const binary = resolve(root, 'backend/target', profile, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server');
const report = reportFor(profile); let directory, deployment, fixture, host, inputs;
try {
  report.stage = '冻结现有binary与独立输入'; const source = sourceDirectory ?? join(root, 'backend/plugins/harmony-device');
  inputs = [binary, process.execPath, toolBinary, join(root, 'scripts/harmony-device-smoke/fake-hdc.rs'),
    ...['manifest.json', 'manifest.example.json', 'aliases.example.json', 'README.md'].map((name) => join(source, name)),
    ...['deviceforge-harmony-device-plugin', 'validate-plugin'].map((name) => join(root, 'backend/target', profile, name + (process.platform === 'win32' ? '.exe' : '')))];
  report.inputs_before = await inputManifest(entry, inputs);
  directory = await mkdtemp(join(tmpdir(), 'deviceforge-harmony-device-')); report.temporary_root = directory;
  deployment = await prepareDeployment({ root, directory, profile, report, source }); fixture = await prepareTool(directory, toolBinary, report);
  report.stage = '空宿主四旧名/四新贡献无回退';
  host = await prepareHost({ root, binary, directory: join(directory, 'data'), bindingsPath: deployment.bindingsPath, report, port: await reservePort() });
  await host.ready(); await plugins(host); await catalog(host, deployment, report, '新宿主无插件', false); await noFallback(host, fixture, report, '新宿主无插件');
  report.stage = '部署当前原binary、四贡献/三能力及未配HDC精确失败';
  await publishAndValidate(deployment, report);
  const loaded = owner(await host.client.post('/api/v2/plugins/harmony-device/load'), deployment, undefined, 'loaded');
  report.generations = { first: loaded.generation }; await plugins(host, loaded); await catalog(host, deployment, report, '首次加载', true, loaded); await missingHdc(host, report);
  await configureHdc(deployment, fixture, report); await preciseErrors(host, fixture, report, { beforeDiscovery: true });
  report.stage = '三入口发现HTTP/MCP、一Job/一工具及坏发现恢复';
  await discoveryEntries(host, deployment, fixture, report); await malformedDiscovery(host, deployment, fixture, report);
  report.stage = '三核心能力及四alias真实业务';
  await preciseErrors(host, fixture, report); await ordinaryBusiness(host, fixture, report); await upload(host, fixture, report); await installBusiness(host, fixture, report);
  report.stage = '安装/卸载跨入口共享写锁、不同设备并行及安装取消';
  await sharedLocks(host, fixture, report); await cancellation(host, fixture, report); await preserveSource(host, fixture, report, '业务完成');
  report.stage = '在途卸载、旧代拒绝、换代重载、历史与源HAP保留';
  await lifecycle(host, deployment, fixture, report); host.assertRunning();
  report.stage = '正常退出、监听释放、逐Job日志及身份复核';
  assert.equal(report.jobs.length, 28, 'HD-EXPECTED-JOB-COUNT');
  assert.equal(report.jobs.filter((item) => item.tool).length, 27, 'HD-EXPECTED-TOOL-COUNT');
  await host.shutdown(); await verifyLogs(directory, host, report); await host.verifyIdentity(); await verifyDeployment(deployment, report);
  report.checks.push({ name: '自有宿主正常exit0、监听释放、逐Job关联日志、输入原字节稳定', passed: true }); report.stage = '完成'; report.passed = true;
} catch (error) { failure(report, error); process.exitCode = 1; }
finally {
  if (host) try { await host.finish(); } catch (error) { failure(report, error, '自有宿主退出/监听释放'); process.exitCode = 1; }
  if (inputs) try { report.inputs_after = await inputManifest(entry, inputs); report.inputs_stable = JSON.stringify(report.inputs_before) === JSON.stringify(report.inputs_after);
    assert.equal(report.inputs_stable, true, '冻结输入须前后原字节稳定'); } catch (error) { failure(report, error, '冻结输入复核'); process.exitCode = 1; }
  if (directory) try { await retain(directory, report); } catch (error) { failure(report, error, '保留原件索引'); report.temporary_retained = directory; process.exitCode = 1; }
  report.shutdown_attempts = report.requests.filter((item) => item.path === '/api/v2/system/shutdown');
  if (!report.passed) process.exitCode = 1;
  const reportPath = await writeReport(root, report); console.log(JSON.stringify({ passed: report.passed, report: reportPath, stage: report.failure_stage ?? report.stage,
    case_id: report.failure_case_id, error: report.error }));
}
