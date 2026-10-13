import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { inputManifest } from './harmony-device-smoke/evidence.mjs';
import { deploymentCanary, hostCanary, operation, sourceContract } from './ai-streaming-smoke/contracts.mjs';
import { cancelledAndLocked, failedProviders, lifecycle, normal, refusedInput, threadRules } from './ai-streaming-smoke/cases.mjs';
import { recordFailure, verifyLogs } from './ai-streaming-smoke/evidence.mjs';
import { finishPendingProbes, prepareFixture } from './ai-streaming-smoke/fixtures.mjs';
import { frontendRound } from './ai-streaming-smoke/frontend.mjs';

const argumentsList = process.argv.slice(2);
assert.ok(argumentsList.every(value => value === '--release' || value === '--frontend-only' || value.startsWith('--frozen-input=')));
assert.ok(argumentsList.filter(value => value.startsWith('--frozen-input=')).length <= 1);
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = argumentsList.includes('--release') ? 'release' : 'debug';
const supplied = argumentsList.find(value => value.startsWith('--frozen-input='));
const frozenInput = supplied ? resolve(supplied.slice('--frozen-input='.length)) : undefined;
const frontendOnly = argumentsList.includes('--frontend-only');
const runId = randomUUID(), suffix = process.platform === 'win32' ? '.exe' : '';
const directory = join(root, 'artifacts', 'ai-streaming-service-' + profile + '-' + runId);
const snapshotRoot = join(directory, 'snapshot'), data = join(directory, 'data');
const report = { timestamp: new Date().toISOString(), profile, run_id: runId, frontend_only: frontendOnly, passed: false,
  checks: [], opened: [], tools: [], jobs: [], requests: [], history_phases: [],
  scope: '真实Rust宿主、HTTP/MCP公开会话、AI插件与受控Node CLI直接进程',
  limitations: ['合成CLI事件不证明真实模型、SDK或旧助手工具', '不证明浏览器、正式TGZ/npx、真机、派生树、远端活动或性能',
    '宿主关闭后的公共Finished由结束日志补证，服务已停止时不伪造HTTP查询'] };
const context = { root, directory, report, retained: [], fixtures: {} };
await mkdir(snapshotRoot, { recursive: true });
await mkdir(data, { recursive: true });
let host, inputs, stage = '冻结实际输入';
try {
  assert.equal(process.platform, 'win32');
  const sourceHost = join(frozenInput ?? join(root, 'backend/target', profile), 'apk-server' + suffix);
  const sourcePlugin = join(frozenInput ?? join(root, 'backend/target', profile), 'deviceforge-ai-assistant-plugin' + suffix);
  const sourceManifest = join(frozenInput ?? join(root, 'backend/plugins/ai-assistant'), 'manifest.json');
  const sourceProbe = join(root, 'artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe');
  const sourceFixture = join(root, 'scripts/ai-streaming-smoke/fixture.cjs');
  const sources = [sourceHost, sourcePlugin, sourceManifest, sourceProbe, sourceFixture];
  const names = ['apk-server' + suffix, 'deviceforge-ai-assistant-plugin' + suffix, 'manifest.json', 'process-probe.exe', 'fixture.cjs'];
  const sourceFiles = ['lib.rs', 'model.rs', 'config.rs', 'sessions.rs', 'turns.rs', 'entry.rs',
    'entry/tests.rs', 'stream/mod.rs', 'stream/process.rs', 'stream/events.rs', 'stream/output.rs', 'stream/state.rs', 'stream/worker.rs'];
  inputs = [...sources, process.execPath, ...sourceFiles.map(name => join(root, 'backend/plugins/ai-assistant/src', name))];
  if (frontendOnly) {
    const frontendInputs = await inputManifest(join(root, 'frontend/src/features/ai-streaming/index.ts'),
      [join(root, 'frontend/src/shared/api/index.ts')]);
    const apiInputs = await inputManifest(join(root, 'frontend/src/shared/api/index.ts'), []);
    report.frontend_inputs_before = [...new Map([...frontendInputs, ...apiInputs].map(entry => [entry.path, entry])).values()];
    inputs.push(...report.frontend_inputs_before.map(entry => entry.path));
  }
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), inputs);
  report.snapshots = [];
  for (let index = 0; index < sources.length; index++) {
    const target = join(snapshotRoot, names[index]);
    const before = await fileIdentity(sources[index]);
    await copyFile(sources[index], target);
    const copied = await fileIdentity(target);
    assert.equal(before.sha256, copied.sha256);
    report.snapshots.push({ original: before, actual: copied });
  }
  const manifest = JSON.parse(await readFile(join(snapshotRoot, 'manifest.json')));
  sourceContract(manifest);
  context.pluginBinary = join(snapshotRoot, names[1]);
  context.probeBinary = join(snapshotRoot, names[3]);
  context.stateRoot = join(directory, 'ai-state');
  const projects = {};
  for (const name of frontendOnly ? ['frontend'] : ['normal', 'nonzero', 'partial', 'late', 'input', 'cancel', 'unknown', 'foreign', 'unload', 'shutdown']) {
    const mode = ['nonzero', 'partial', 'late'].includes(name) ? name : 'normal';
    const fixture = await prepareFixture(directory, join(snapshotRoot, names[4]), name, randomUUID(), mode);
    context.fixtures[name] = fixture;
    projects[name] = fixture.root;
  }
  report.fixture_inputs = Object.values(context.fixtures).flatMap(fixture => fixture.files);
  stage = '启动独占真实宿主';
  const previous = { host: process.env.DF_AI_HOST_CANARY, key: process.env.OPENAI_API_KEY };
  try {
    process.env.DF_AI_HOST_CANARY = hostCanary;
    process.env.OPENAI_API_KEY = hostCanary;
    host = await prepareHost({ root, binary: join(snapshotRoot, names[0]), directory: data, report, port: await reservePort() });
  } finally {
    if (previous.host === undefined) delete process.env.DF_AI_HOST_CANARY; else process.env.DF_AI_HOST_CANARY = previous.host;
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.key;
  }
  context.host = host;
  await host.ready();
  assert.ok(!(await host.client.tools()).includes(operation));
  assert.deepEqual(await host.client.json('/api/v2/session-definitions'), { revision: 0, sessions: [] });
  const pluginRoot = join(host.plugins, 'ai-assistant');
  await mkdir(pluginRoot);
  const configPath = join(pluginRoot, 'ai-assistant.config.json');
  await writeFile(configPath, JSON.stringify({ format_version: 1, executable: process.execPath,
    args: ['--public-fixture-arg'], projects, environment: { DF_AI_DEPLOYMENT_CANARY: deploymentCanary },
    state_root: context.stateRoot }), { flag: 'wx' });
  manifest.executable = context.pluginBinary;
  manifest.args = ['--config', configPath];
  await writeFile(join(pluginRoot, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  report.deployment = { manifest: await fileIdentity(join(pluginRoot, 'manifest.json')), config: await fileIdentity(configPath),
    node: await fileIdentity(process.execPath), fixtures: report.fixture_inputs };
  stage = '动态会话发现';
  const loaded = await host.client.post('/api/v2/plugins/ai-assistant/load');
  assert.deepEqual(loaded.sessions, [operation]);
  assert.equal(loaded.operations.length, 5);
  context.generation = loaded.generation;
  const definitions = await host.client.json('/api/v2/session-definitions');
  assert.equal(definitions.sessions.length, 1);
  assert.equal(definitions.sessions[0].id, operation);
  assert.deepEqual(definitions.sessions[0].execution, { api_version: 1, total_timeout_ms: 600000, source: 'declared' });
  assert.deepEqual(await host.client.tool('deviceforge.list_session_definitions', {}), definitions);
  assert.ok((await host.client.tools()).includes(operation));
  report.checks.push({ name: '原协议4五项贡献与协议5单会话动态注册', passed: true });
  const cases = frontendOnly ? [['前端公开工厂真实消费', frontendRound]] : [['正常增量与恢复', normal], ['提供者失败', failedProviders],
    ['追加Input拒绝', refusedInput], ['取消及同线程锁', cancelledAndLocked], ['持久线程规则', threadRules], ['卸载重载与宿主关闭', lifecycle]];
  for (const [name, run] of cases) {
    stage = name;
    await run(context);
  }
  stage = '冻结身份与日志';
  await host.verifyIdentity();
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), inputs);
  assert.deepEqual(report.inputs_after, report.inputs_before);
  if (frontendOnly) {
    report.frontend_inputs_after = await Promise.all(report.frontend_inputs_before.map(entry => fileIdentity(entry.path)));
    assert.deepEqual(report.frontend_inputs_after, report.frontend_inputs_before);
  }
  report.snapshots_after = await Promise.all(report.snapshots.map(entry => fileIdentity(entry.actual.path)));
  assert.deepEqual(report.snapshots_after, report.snapshots.map(entry => entry.actual));
  report.fixture_inputs_after = await Promise.all(report.fixture_inputs.map(entry => fileIdentity(entry.path)));
  assert.deepEqual(report.fixture_inputs_after, report.fixture_inputs);
  await verifyLogs(context);
  report.passed = true;
} catch (error) { recordFailure(report, error, stage); }
finally {
  if (host) {
    try { await host.finish(); } catch (error) { recordFailure(report, error, '宿主最终清理'); }
  }
  try { await finishPendingProbes(report); } catch (error) { recordFailure(report, error, '探针最终清理'); }
  report.completed_at = new Date().toISOString();
  for (const entry of report.opened) delete entry.pending;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length,
    sessions: report.opened.length, jobs: report.jobs.length, tools: report.tools.length,
    failure_stage: report.failure_stage, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
