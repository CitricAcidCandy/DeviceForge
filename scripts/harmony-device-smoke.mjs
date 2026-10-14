import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { catalog, missingHdc } from './harmony-device-smoke/bootstrap.mjs';
import { noFallback, preciseErrors, ordinaryBusiness } from './harmony-device-smoke/actions.mjs';
import {
  prepareDeployment,
  publishAndValidate,
  verifyDeployment,
} from './harmony-device-smoke/deployment.mjs';
import { discoveryEntries, malformedDiscovery } from './harmony-device-smoke/discovery.mjs';
import {
  upload,
  installBusiness,
  sharedLocks,
  cancellation,
  preserveSource,
} from './harmony-device-smoke/artifacts.mjs';
import { configureHdc, prepareTool } from './harmony-device-smoke/fixtures.mjs';
import { lifecycle, owner, plugins } from './harmony-device-smoke/lifecycle.mjs';
import {
  failure,
  inputManifest,
  reportFor,
  retain,
  verifyLogs,
  writeReport,
} from './harmony-device-smoke/evidence.mjs';
import { applications, applicationInputErrors } from './harmony-device-smoke/applications.mjs';
import {
  applicationCancellation,
  applicationFailureResults,
  applicationSharedLocks,
} from './harmony-device-smoke/application-resources.mjs';
import {
  applicationDetails,
  applicationDetailFailures,
  applicationDetailInputErrors,
  applicationDetailResources,
} from './harmony-device-smoke/details.mjs';
import { verifyInventory } from './harmony-device-smoke/inventory.mjs';
import {
  networkBeforeDiscovery,
  networkCancellation,
  networkFailures,
  networkInputErrors,
  networkLifecycle,
  networkSemanticErrors,
  networkSharedLocks,
} from './harmony-device-smoke/network.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)),
  entry = fileURLToPath(import.meta.url);
let profile = 'debug',
  toolBinary,
  sourceDirectory;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--release') {
    assert.equal(profile, 'debug', '--release不可重复');
    profile = 'release';
  } else if (args[index] === '--tool-binary') {
    assert.equal(toolBinary, undefined, '--tool-binary不可重复');
    toolBinary = args[++index];
    assert.ok(toolBinary && isAbsolute(toolBinary), '--tool-binary须为独立假HDC绝对路径');
  } else if (args[index] === '--source-directory') {
    assert.equal(sourceDirectory, undefined, '--source-directory不可重复');
    sourceDirectory = args[++index];
    assert.ok(
      sourceDirectory && isAbsolute(sourceDirectory),
      '--source-directory须为冻结源元数据绝对路径',
    );
  } else assert.fail('仅支持--release、--tool-binary及--source-directory');
}
assert.ok(toolBinary, '主代理先编译本目录fake-hdc.rs，再传入--tool-binary');
const binary = resolve(
  root,
  'backend/target',
  profile,
  process.platform === 'win32' ? 'apk-server.exe' : 'apk-server',
);
const report = reportFor(profile);
let directory, deployment, fixture, host, inputs;
try {
  report.stage = '冻结现有binary与独立输入';
  const source = sourceDirectory ?? join(root, 'backend/plugins/harmony-device');
  inputs = [
    binary,
    process.execPath,
    toolBinary,
    join(root, 'scripts/harmony-device-smoke/fake-hdc.rs'),
    ...['manifest.json', 'manifest.example.json', 'aliases.example.json', 'README.md'].map((name) =>
      join(source, name),
    ),
    ...['deviceforge-harmony-device-plugin', 'validate-plugin'].map((name) =>
      join(root, 'backend/target', profile, name + (process.platform === 'win32' ? '.exe' : '')),
    ),
  ];
  report.inputs_before = await inputManifest(entry, inputs);
  directory = await mkdtemp(join(tmpdir(), 'deviceforge-harmony-device-'));
  report.temporary_root = directory;
  deployment = await prepareDeployment({ root, directory, profile, report, source });
  fixture = await prepareTool(directory, toolBinary, report);
  report.stage = '空宿主十绑定/十贡献无回退';
  host = await prepareHost({
    root,
    binary,
    directory: join(directory, 'data'),
    bindingsPath: deployment.bindingsPath,
    report,
    port: await reservePort(),
  });
  await host.ready();
  await plugins(host);
  await catalog(host, deployment, report, '新宿主无插件', false);
  await noFallback(host, fixture, report, '新宿主无插件');
  report.stage = '部署当前原binary、十贡献/九定义能力及未配HDC精确失败';
  await publishAndValidate(deployment, report);
  const loaded = owner(
    await host.client.post('/api/v2/plugins/harmony-device/load'),
    deployment,
    undefined,
    'loaded',
  );
  report.generations = { first: loaded.generation };
  await plugins(host, loaded);
  await catalog(host, deployment, report, '首次加载', true, loaded);
  await missingHdc(host, report);
  await configureHdc(deployment, fixture, report);
  await preciseErrors(host, fixture, report, { beforeDiscovery: true });
  report.stage = '未发现目录的提供者连接/重复/静默断开、shape拒绝与数值语义失败Job';
  await networkInputErrors(host, fixture, report);
  await networkSemanticErrors(host, fixture, report);
  await networkBeforeDiscovery(host, fixture, report);
  report.stage = '三入口发现HTTP/MCP、一Job/一工具及坏发现恢复';
  await discoveryEntries(host, deployment, fixture, report);
  await malformedDiscovery(host, deployment, fixture, report);
  report.stage = '七设备能力及十绑定真实业务';
  await preciseErrors(host, fixture, report);
  await ordinaryBusiness(host, fixture, report);
  await upload(host, fixture, report);
  await installBusiness(host, fixture, report);
  report.stage = '应用启动停止重置三入口与自动详情，严格输入与工具失败';
  await applicationInputErrors(host, fixture, report);
  await applications(host, fixture, report);
  await applicationFailureResults(host, fixture, report);
  report.stage = '应用详情三入口双协议、严格解析、并行读取与取消';
  await applicationDetailInputErrors(host, fixture, report);
  await applicationDetails(host, fixture, report);
  await applicationDetailFailures(host, fixture, report);
  await applicationDetailResources(host, fixture, report);
  report.stage = '网络结果精确失败、provider写屏障正反向与在途取消';
  await networkFailures(host, fixture, report);
  await networkSharedLocks(host, fixture, report);
  await networkCancellation(host, fixture, report);
  report.stage = '安装/卸载跨入口共享写锁、不同设备并行及安装取消';
  await sharedLocks(host, fixture, report);
  await cancellation(host, fixture, report);
  await preserveSource(host, fixture, report, '业务完成');
  await applicationSharedLocks(host, fixture, report);
  await applicationCancellation(host, fixture, report);
  report.stage = '在途卸载、旧代拒绝、换代重载、历史与源HAP保留';
  await lifecycle(host, deployment, fixture, report);
  host.assertRunning();
  report.stage = '网络独立在途卸载、旧代拒绝、新代无发现调用与历史保留';
  await networkLifecycle(host, deployment, fixture, report);
  host.assertRunning();
  report.stage = '正常退出、监听释放、逐Job日志及身份复核';
  await verifyInventory(fixture, report);
  await host.shutdown();
  await verifyLogs(directory, host, report);
  await host.verifyIdentity();
  await verifyDeployment(deployment, report);
  report.checks.push({
    name: '自有宿主正常exit0、监听释放、逐Job关联日志、输入原字节稳定',
    passed: true,
  });
  report.stage = '完成';
  report.passed = true;
} catch (error) {
  failure(report, error);
  process.exitCode = 1;
} finally {
  if (host)
    try {
      await host.finish();
    } catch (error) {
      failure(report, error, '自有宿主退出/监听释放');
      process.exitCode = 1;
    }
  if (inputs)
    try {
      report.inputs_after = await inputManifest(entry, inputs);
      report.inputs_stable =
        JSON.stringify(report.inputs_before) === JSON.stringify(report.inputs_after);
      assert.equal(report.inputs_stable, true, '冻结输入须前后原字节稳定');
    } catch (error) {
      failure(report, error, '冻结输入复核');
      process.exitCode = 1;
    }
  if (directory)
    try {
      await retain(directory, report);
    } catch (error) {
      failure(report, error, '保留原件索引');
      report.temporary_retained = directory;
      process.exitCode = 1;
    }
  report.shutdown_attempts = report.requests.filter(
    (item) => item.path === '/api/v2/system/shutdown',
  );
  if (!report.passed) process.exitCode = 1;
  const reportPath = await writeReport(root, report);
  console.log(
    JSON.stringify({
      passed: report.passed,
      report: reportPath,
      stage: report.failure_stage ?? report.stage,
      case_id: report.failure_case_id,
      error: report.error,
    }),
  );
}
