import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDeployment, publishDeployment, suffixes, verifyDeploymentIdentity } from './android-packages-smoke/deployment.mjs';
import { failure, reportFor, retain, verifyLogs, writeReport } from './android-packages-smoke/evidence.mjs';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { verifyFourJobs } from './android-packages-smoke/jobs.mjs';
import { collectProcesses } from './android-packages-smoke/process-evidence.mjs';
import { sharedJob } from './ordinary-deadline-http/client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let profile = 'debug', toolBinary;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--release') {
    assert.equal(profile, 'debug', '--release不可重复'); profile = 'release';
  } else if (argument === '--tool') {
    assert.equal(toolBinary, undefined, '--tool不可重复'); toolBinary = args[++index];
    assert.ok(toolBinary && isAbsolute(toolBinary), '--tool须为主代理已编译的绝对工具路径');
  } else assert.fail('仅接受--release及--tool绝对路径');
}
assert.ok(toolBinary, '必须显式传入主代理预编译的std-only工具；本脚本不编译');
const binary = resolve(root, 'backend/target', profile, `apk-server${process.platform === 'win32' ? '.exe' : ''}`);
const pluginBinary = resolve(root, 'backend/target', profile, `deviceforge-android-packages-plugin${process.platform === 'win32' ? '.exe' : ''}`);
const report = reportFor(profile);
let directory, deployment, host;

async function visibleOperations() {
  const http = await host.client.json('/api/v2/operations');
  assert.deepEqual(await host.client.tool('deviceforge.list_operations'), http);
  const tools = await host.client.tools();
  return { http, ids: new Set(http.map((entry) => entry.id)), tools: new Set(tools) };
}

async function verifyRegistered() {
  const { http, ids, tools } = await visibleOperations();
  report.registered_operations = [];
  for (const suffix of suffixes) {
    const old = `android.package.${suffix}`, target = `plugin.android-packages.${suffix}`;
    for (const id of [old, target]) { assert.ok(ids.has(id)); assert.ok(tools.has(id)); }
    const oldOperation = http.find((item) => item.id === old), targetOperation = http.find((item) => item.id === target);
    assert.deepEqual(oldOperation.execution, targetOperation.execution, '旧alias复制真实target有效预算');
    report.registered_operations.push({ alias: old, target, execution: targetOperation.execution,
      boundary: ['manifest', 'extract_apk'].includes(suffix) ? '本脚本实际执行' : '仅目录注册，未执行业务' });
  }
}

try {
  report.stage = '本次便携包/双清单/配置/工具身份';
  directory = await mkdtemp(join(tmpdir(), 'deviceforge-android-packages-'));
  deployment = await prepareDeployment({ root, directory, pluginBinary, toolBinary, report });
  const port = await reservePort();
  report.stage = '空插件宿主与七alias配置';
  host = await prepareHost({ root, binary, directory: join(directory, 'data'), bindingsPath: deployment.bindingsPath, report, port });
  await host.ready();
  const before = await visibleOperations();
  for (const suffix of suffixes) {
    assert.equal(before.ids.has(`android.package.${suffix}`), false, '未加载target的旧alias不得回退内置');
    assert.equal(before.tools.has(`plugin.android-packages.${suffix}`), false);
  }
  report.stage = '发布本次便携目录与公开load';
  await publishDeployment(deployment, report);
  const loaded = await host.client.post('/api/v2/plugins/android-packages/load');
  assert.equal(loaded.state, 'loaded'); assert.equal(loaded.cleanup_failed, false);
  report.plugin_generation = loaded.generation;
  await verifyRegistered();
  report.stage = '4Job共享历史/DTO/实际产物/独占工具门闩';
  await verifyFourJobs(host, deployment, report); host.assertRunning();
  report.stage = '公开卸载后贡献撤销及四Job历史保留';
  const unloaded = await host.client.tool('deviceforge.unload_plugin', { id: 'android-packages' });
  assert.equal(unloaded.state, 'unloaded'); assert.equal(unloaded.cleanup_failed, false);
  const after = await visibleOperations();
  for (const suffix of suffixes) for (const id of [`android.package.${suffix}`, `plugin.android-packages.${suffix}`]) {
    assert.equal(after.ids.has(id), false); assert.equal(after.tools.has(id), false);
  }
  for (const entry of report.jobs) assert.deepEqual(await sharedJob(host.client, entry), entry.history);
  report.checks.push({ name: 'HTTP/MCP七项目录撤销、四Job旧operation/input/result卸载后历史保留', passed: true });
  report.stage = '宿主正常退出/端口释放/所有响应ID落盘';
  await host.shutdown();
  await collectProcesses(deployment, report);
  await verifyLogs(directory, host, report);
  await host.verifyIdentity(); await verifyDeploymentIdentity(deployment, report);
  // 成功标记在实际退出、监听释放、日志和输入身份核对全部完成之后。
  report.stage = '完成'; report.passed = true;
} catch (error) {
  failure(report, error); process.exitCode = 1;
} finally {
  if (host) {
    try { await host.finish(); } catch (error) { failure(report, error, '自有宿主收口与监听释放'); process.exitCode = 1; }
  }
  if (deployment) {
    try { await collectProcesses(deployment, report); }
    catch (error) { failure(report, error, '本次工具与插件实际PID收尾'); process.exitCode = 1; }
  }
  report.shutdown_attempts = report.requests.filter((request) => request.path === '/api/v2/system/shutdown');
  if (directory) {
    try { await retain(directory, report); }
    catch (error) { failure(report, error, '保留证据索引'); report.temporary_retained = directory; process.exitCode = 1; }
  }
  await writeReport(root, report);
  console.log(JSON.stringify(report, null, 2));
}
