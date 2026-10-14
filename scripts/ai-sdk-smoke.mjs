import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import {
  deploymentCanary,
  hostCanary,
  operation,
  pluginId,
  profileName,
  prompt,
  sdkVersion,
} from './ai-sdk-smoke/contracts.mjs';
import {
  cancellation,
  failures,
  lifecycle,
  ordinary,
  shutdown,
  streaming,
  threadRules,
} from './ai-sdk-smoke/cases.mjs';
import { frontend } from './ai-sdk-smoke/frontend.mjs';
import { prepareProject } from './ai-sdk-smoke/fixtures.mjs';
import { finishPendingProbes } from './ai-sdk-smoke/processes.mjs';
import { freezeInputs, verifyInputs } from './ai-sdk-smoke/inputs.mjs';
import { recordFailure, retain, verifyLogs } from './ai-sdk-smoke/evidence.mjs';

const args = process.argv.slice(2);
assert.ok(
  args.every(
    (value) =>
      value === '--release' || value === '--frontend-only' || value.startsWith('--frozen-input='),
  ),
);
assert.equal(
  args.filter((value) => value.startsWith('--frozen-input=')).length,
  1,
  '必须显式提供已冻结完整输入',
);
assert.equal(new Set(args).size, args.length);
const supplied = args
  .find((value) => value.startsWith('--frozen-input='))
  .slice('--frozen-input='.length);
assert.ok(isAbsolute(supplied));
assert.equal(process.platform, 'win32');
assert.equal(process.version, 'v24.14.0');
const root = fileURLToPath(new URL('../', import.meta.url)),
  entry = fileURLToPath(import.meta.url);
const profile = args.includes('--release') ? 'release' : 'debug',
  frontendOnly = args.includes('--frontend-only');
const runId = randomUUID(),
  directory = join(root, 'artifacts', 'ai-sdk-service-' + profile + '-' + runId);
const snapshotRoot = join(directory, 'snapshot'),
  data = join(directory, 'data');
const report = {
  timestamp: new Date().toISOString(),
  profile,
  run_id: runId,
  frontend_only: frontendOnly,
  passed: false,
  real_model_verified: false,
  checks: [],
  opened: [],
  tools: [],
  jobs: [],
  requests: [],
  history_phases: [],
  process_families: [],
  version_probes: [],
  runtime_status: [],
  scope:
    '冻结真实Rust宿主、独立AI SDK插件、官方SDK0.162.1、Node24.14.0、原生模拟CLI及后代的公开HTTP/MCP和前端工厂消费',
  limitations: [
    '模拟CLI回答仅证明官方SDK与真实宿主接线，不证明真实模型、真实Codex CLI或远端账号',
    '本轮model_verified隔离资格由模拟轮次产生，报告real_model_verified始终false',
    '真实OS探针观察就绪时持句柄的CLI、两代后代、Node、监督与代理；短寿命Node版本/SDK加载探测由生产范围资格确认',
    '不证明浏览器呈现、正式TGZ/npx分发、其它操作系统、真机、远端活动或性能',
    '宿主关闭后公共Finished由结束日志补证，服务停止时不伪造HTTP终态查询',
    'MCP目录通知另行验收；本轮维持POST元数据合同',
  ],
};
const context = {
  root,
  directory,
  snapshotRoot,
  report,
  retained: [],
  fixtures: {},
  versionOrdinal: 0,
  prompt,
};
await mkdir(snapshotRoot, { recursive: true });
await mkdir(data, { recursive: true });
let host,
  stage = '完整冻结输入核对';
try {
  await freezeInputs(context, resolve(supplied), entry);
  context.stateRoot = join(directory, 'ai-sdk-state');
  const projects = {};
  const labels = frontendOnly
    ? ['frontend-ordinary', 'frontend-assistant', 'frontend-stream']
    : [
        'ordinary',
        'assistant',
        'stream',
        'nonzero',
        'missing',
        'late',
        'cancel',
        'foreign',
        'unload',
        'shutdown',
        'frontend-ordinary',
        'frontend-assistant',
        'frontend-stream',
      ];
  for (const label of labels) {
    const mode = ['nonzero', 'missing', 'late', 'cancel'].includes(label)
      ? label
      : label === 'shutdown'
        ? 'cancel'
        : label === 'assistant'
          ? 'four'
          : label === 'frontend-assistant'
            ? label
            : 'normal';
    const fixture = await prepareProject(directory, label, mode);
    context.fixtures[label] = fixture;
    projects[label] = fixture.root;
  }
  report.fixture_inputs = Object.values(context.fixtures).flatMap((fixture) => fixture.files);
  const configPath = join(snapshotRoot, 'plugin/ai-sdk.config.json');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        format_version: 1,
        profile: profileName,
        node_executable: context.nodeBinary,
        node_version: '24.14.0',
        sdk_entry: join(snapshotRoot, 'sdk-package/dist/index.js'),
        sdk_version: sdkVersion,
        cli_executable: context.cliBinary,
        cli_version: sdkVersion,
        projects,
        state_root: context.stateRoot,
        codex_home: join(directory, 'provider-home'),
        environment: { AI_SDK_TEST_CANARY: deploymentCanary },
        thread_options: {},
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  report.configuration = await fileIdentity(configPath);
  stage = '独占真实宿主启动';
  const previous = { host: process.env.DF_AI_SDK_HOST_CANARY, key: process.env.OPENAI_API_KEY };
  try {
    process.env.DF_AI_SDK_HOST_CANARY = hostCanary;
    process.env.OPENAI_API_KEY = hostCanary;
    host = await prepareHost({
      root,
      binary: context.hostBinary,
      directory: data,
      report,
      port: await reservePort(),
    });
  } finally {
    if (previous.host === undefined) delete process.env.DF_AI_SDK_HOST_CANARY;
    else process.env.DF_AI_SDK_HOST_CANARY = previous.host;
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.key;
  }
  context.host = host;
  await host.ready();
  assert.ok(!(await host.client.tools()).includes(operation));
  assert.deepEqual(await host.client.json('/api/v2/session-definitions'), {
    revision: 0,
    sessions: [],
  });
  const pluginRoot = join(host.plugins, pluginId);
  await mkdir(pluginRoot);
  const manifest = { ...context.manifest, executable: context.pluginBinary, args: [] };
  await writeFile(join(pluginRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  report.deployment_manifest = await fileIdentity(join(pluginRoot, 'manifest.json'));
  stage = '普通六贡献与协议5会话发现';
  const loaded = await host.client.post('/api/v2/plugins/' + pluginId + '/load');
  assert.deepEqual(loaded.sessions, [operation]);
  assert.equal(loaded.operations.length, 6);
  context.generation = loaded.generation;
  const definitions = await host.client.json('/api/v2/session-definitions');
  assert.equal(definitions.sessions.length, 1);
  assert.equal(definitions.sessions[0].id, operation);
  assert.deepEqual(definitions.sessions[0].execution, {
    api_version: 1,
    total_timeout_ms: 600000,
    source: 'declared',
  });
  assert.deepEqual(await host.client.tool('deviceforge.list_session_definitions', {}), definitions);
  const names = await host.client.tools();
  assert.ok(names.includes(operation));
  for (const name of context.manifest.operations)
    assert.ok(names.includes('plugin.ai-sdk.' + name.name));
  report.checks.push({ name: '原协议4普通六贡献和协议5单会话动态注册', passed: true });
  const cases = frontendOnly
    ? [['前端普通及实时SDK工厂', frontend]]
    : [
        ['前端普通及实时SDK工厂', frontend],
        ['普通六贡献与隔离资格', ordinary],
        ['实时SDK增量与恢复', streaming],
        ['提供者失败候选', failures],
        ['显式取消', cancellation],
        ['持久线程资格', threadRules],
        ['热卸载新代际与旧输出', lifecycle],
      ];
  for (const [name, run] of cases) {
    stage = name;
    report.stage = stage;
    console.log(JSON.stringify({ phase: '开始', stage }));
    await run(context);
  }
  stage = '正常宿主退出与活动资源结束';
  if (frontendOnly) await host.shutdown();
  else await shutdown(context);
  await host.verifyIdentity();
  stage = '冻结身份、逐项后台日志和原件';
  await verifyInputs(context, entry);
  await verifyLogs(context);
  assert.deepEqual(await fileIdentity(configPath), report.configuration);
  assert.deepEqual(
    await fileIdentity(join(pluginRoot, 'manifest.json')),
    report.deployment_manifest,
  );
  report.passed = true;
} catch (error) {
  recordFailure(report, error, stage);
} finally {
  if (host)
    try {
      await host.finish();
    } catch (error) {
      recordFailure(report, error, '宿主最终清理');
    }
  try {
    await finishPendingProbes(report);
  } catch (error) {
    recordFailure(report, error, '自有探针最终清理');
  }
  try {
    await retain(context);
  } catch (error) {
    recordFailure(report, error, '全部原件索引');
  }
  report.completed_at = new Date().toISOString();
  report.stage = report.passed ? '完成' : report.failure_stage;
  for (const opened of report.opened) delete opened.pending;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      directory,
      passed: report.passed,
      real_model_verified: false,
      checks: report.checks.length,
      sessions: report.opened.length,
      jobs: report.jobs.length,
      tools: report.tools.length,
      failure_stage: report.failure_stage,
      failure: report.failure,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
