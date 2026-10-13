import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { inputManifest } from './harmony-device-smoke/evidence.mjs';
import { apks, baseApk, featureApk } from './apks-advanced-smoke/contracts.mjs';
import { prepareDeployment, publish, verifyDeployment } from './apks-advanced-smoke/deployment.mjs';
import { discover, extraction, inputRules, installation } from './apks-advanced-smoke/cases.mjs';
import { finishPendingProbes, prepareTool } from './apks-advanced-smoke/fixtures.mjs';
import { frontend } from './apks-advanced-smoke/frontend.mjs';
import { lifecycle, visibility } from './apks-advanced-smoke/lifecycle.mjs';
import { logs, failure } from './apks-advanced-smoke/evidence.mjs';
import { upload } from './apks-advanced-smoke/artifacts.mjs';
import { qualification } from './apks-advanced-smoke/qualification.mjs';
import { entries } from './apks-advanced-smoke/zip.mjs';

const argumentsList = process.argv.slice(2);
assert.ok(argumentsList.every(value => value.startsWith('--frozen-input=') || value.startsWith('--tool=')));
assert.ok(argumentsList.filter(value => value.startsWith('--frozen-input=')).length <= 1);
assert.ok(argumentsList.filter(value => value.startsWith('--tool=')).length <= 1);
const root = fileURLToPath(new URL('../', import.meta.url));
const option = (name, fallback) => resolve(argumentsList.find(value => value.startsWith(name + '='))?.slice(name.length + 1) ?? join(root, fallback));
const frozen = option('--frozen-input', 'artifacts/apks-advanced-frozen-debug-20261012');
const sourceTool = option('--tool', 'artifacts/apks-advanced-fixtures-20261012/fake-java.exe');
const runId = randomUUID();
const directory = join(root, 'artifacts', 'apks-advanced-service-debug-' + runId);
const snapshot = join(directory, 'snapshot');
const report = { timestamp: new Date().toISOString(), run_id: runId, profile: 'debug', passed: false,
  checks: [], jobs: [], tools: [], artifacts: [], downloads: [], requests: [], history_phases: [],
  scope: '冻结真实Rust宿主/Android双插件、HTTP/MCP公开贡献及真实前端工厂、可控Java/ADB与真实OS直接父子退出',
  limitations: ['合成APKS和占位JAR不证明真实bundletool/toc匹配、依赖展开或真机安装',
    '只读现有JAR入口/版本资格，不执行Java，不扫描整盘寻找包',
    '直接进程OS句柄证据不证明派生树、共享ADB daemon或设备事务回滚',
    '未运行release、正式TGZ、npx、浏览器、跨平台或性能验收'] };
const context = { root, directory, report };
await mkdir(snapshot, { recursive: true });
await mkdir(join(directory, 'data'));
let host, inputs, stage = '冻结真实输入';

async function frontendInputs() {
  const sources = ['frontend/src/features/package-analysis/index.ts', 'frontend/src/shared/api/index.ts', 'frontend/src/shared/jobs/index.ts'];
  const manifests = await Promise.all(sources.map(value => inputManifest(join(root, value), [])));
  return [...new Map(manifests.flat().map(value => [value.path, value])).values()].sort((left, right) => left.path.localeCompare(right.path));
}

try {
  assert.equal(process.platform, 'win32');
  const originalIdentity = JSON.parse(await readFile(join(frozen, 'identity.json'), 'utf8'));
  assert.equal(originalIdentity.files.length, 10);
  const members = ['apk-server.exe', 'validate-plugin.exe', 'deviceforge-android-device-plugin.exe', 'deviceforge-android-packages-plugin.exe',
    ...['android-device', 'android-packages'].flatMap(id => ['manifest.json', 'manifest.example.json', 'aliases.example.json'].map(name => id + '/' + name))];
  const sources = [...members.map(name => join(frozen, name)), sourceTool,
    join(root, 'artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe')];
  const names = [...members, 'fake-java.exe', 'process-probe.exe'];
  report.snapshots = [];
  for (let index = 0; index < sources.length; index++) {
    const original = await fileIdentity(sources[index]);
    if (index < 10) {
      const saved = originalIdentity.files.find(value => value.actual.path.replaceAll('\\', '/').endsWith('/' + members[index]));
      assert.ok(saved);
      assert.equal(original.sha256, saved.actual.sha256);
      assert.equal(original.bytes, saved.actual.bytes);
    }
    const target = join(snapshot, names[index]);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(sources[index], target);
    const actual = await fileIdentity(target);
    assert.equal(actual.sha256, original.sha256);
    report.snapshots.push({ original, actual });
  }
  const sourceRoots = ['backend/crates/android-package-core/src', 'backend/plugins/android-packages/src',
    'backend/plugins/android-device/src'];
  const businessSources = [];
  for (const relative of sourceRoots) {
    for (const entry of await readdir(join(root, relative), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.rs')) businessSources.push(join(entry.parentPath, entry.name));
    }
  }
  report.frontend_inputs_before = await frontendInputs();
  inputs = [...sources, join(frozen, 'identity.json'), process.execPath, join(root, 'scripts/apks-advanced-smoke/fake-java.rs'),
    ...businessSources, ...report.frontend_inputs_before.map(value => value.path)];
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), inputs);
  report.frontend_inputs_scope = '实际Node24直接加载的前端公开工厂与全部相对导入源码，运行前后摘要核对';
  const gold = entries(apks);
  assert.deepEqual([...gold.keys()], ['toc.pb', 'splits/base-master.apk', 'splits/feature_1.apk']);
  assert.deepEqual(gold.get('toc.pb'), Buffer.from([8, 1]));
  assert.deepEqual(gold.get('splits/base-master.apk'), baseApk);
  assert.deepEqual(gold.get('splits/feature_1.apk'), featureApk);
  report.checks.push({ name: '冻结十成员身份及独立APKS/两APK金样原字节', passed: true });
  context.probeBinary = join(snapshot, 'process-probe.exe');
  context.tool = await prepareTool(context, join(snapshot, 'fake-java.exe'));
  const bindingsPath = await prepareDeployment(context, snapshot);
  stage = '限定真实工具资格';
  await qualification(report);
  stage = '独占真实宿主与空目录';
  host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'), directory: join(directory, 'data'),
    report, bindingsPath, port: await reservePort() });
  context.host = host;
  await host.ready();
  await visibility(context, false);
  stage = '双插件发布与公开贡献';
  await publish(context, join(snapshot, 'validate-plugin.exe'));
  await visibility(context, true);
  context.source = await upload(context, '高级模块.apks', apks);
  const rounds = [
    ['HTTP基本规格兼容', { caseId: 'HTTP基本规格兼容' }],
    ['MCP高级规格与模块instant', { caseId: 'MCP高级规格与模块instant', advanced: true, transport: 'mcp' }],
    ['空高级列表/null选择/false缺省', { caseId: '空高级列表/null选择/false缺省', empty: true }],
    ['ALL单模块选择', { caseId: 'ALL单模块选择', all: true }],
    ['旧alias四字段历史', { caseId: '旧alias四字段历史', alias: true, transport: 'mcp' }],
  ];
  for (const [name, options] of rounds) { stage = name; await extraction(context, options); }
  stage = '设备资格';
  await discover(context);
  for (const options of [
    { caseId: 'HTTP安装缺省兼容' },
    { caseId: 'MCP安装嵌套modules', modules: ['base', 'feature_1'], transport: 'mcp' },
    { caseId: 'HTTP安装modules null', modules: null },
    { caseId: '设备能力安装ALL', modules: ['ALL'], capability: true },
  ]) { stage = options.caseId; await installation(context, options); }
  stage = '输入与资格规则';
  await inputRules(context);
  stage = '真实前端基础消费';
  await frontend(context);
  stage = '在途取消卸载/撤目录/历史/新代次';
  await lifecycle(context);
  stage = '正常宿主关闭与身份';
  await host.shutdown();
  await host.verifyIdentity();
  await verifyDeployment(context);
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), inputs);
  assert.deepEqual(report.inputs_after, report.inputs_before);
  report.frontend_inputs_after = await frontendInputs();
  assert.deepEqual(report.frontend_inputs_after, report.frontend_inputs_before);
  report.snapshots_after = await Promise.all(report.snapshots.map(value => fileIdentity(value.actual.path)));
  assert.deepEqual(report.snapshots_after, report.snapshots.map(value => value.actual));
  report.fixture_inputs_after = await Promise.all(report.fixture.files.map(value => fileIdentity(value.path)));
  assert.deepEqual(report.fixture_inputs_after, report.fixture.files);
  stage = '实际日志关联';
  await logs(context);
  report.passed = true;
} catch (error) { failure(report, error, stage); }
finally {
  if (host) {
    try { await host.finish(); } catch (error) { failure(report, error, '宿主最终清理'); }
  }
  try { await finishPendingProbes(report); } catch (error) { failure(report, error, '自有探针最终清理'); }
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, jobs: report.jobs.length,
    tools: report.tools.length, failure_stage: report.failure_stage }));
  if (!report.passed) process.exitCode = 1;
}
