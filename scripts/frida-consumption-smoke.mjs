import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { inputManifest } from './harmony-device-smoke/evidence.mjs';
import { jobEvents, sharedJob } from './ordinary-deadline-http/client.mjs';
import { poll } from './terminal-interactive-smoke/cases.mjs';
import { frontendSources, verifyLogs } from './frida-consumption-smoke/evidence.mjs';
import {
  noticeBytes,
  prepareTools,
  serverBytes,
  scriptBytes,
  verifyTools,
} from './frida-consumption-smoke/fixtures.mjs';
import {
  beginTool,
  releaseTool,
  finishTools,
  finishPendingProbes,
} from './frida-consumption-smoke/observations.mjs';
import {
  deploymentResult,
  permissionScript,
  processesResult,
  runningResult,
  scriptResult,
  statusResult,
} from './frida-consumption-smoke/contracts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(
  args.every(
    (argument) =>
      argument === '--release' ||
      argument.startsWith('--tool=') ||
      argument.startsWith('--frozen-input='),
  ),
);
assert.ok(args.filter((argument) => argument.startsWith('--tool=')).length <= 1);
assert.ok(args.filter((argument) => argument.startsWith('--frozen-input=')).length <= 1);
const frozen = args.find((argument) => argument.startsWith('--frozen-input='))?.slice(15);
const profile = args.includes('--release') ? 'release' : 'debug';
const suffix = process.platform === 'win32' ? '.exe' : '';
const toolSource = resolve(
  args.find((argument) => argument.startsWith('--tool='))?.slice(7) ??
    join(root, 'artifacts/frida-consumption-fixtures-20261012', 'frida-tool' + suffix),
);
const runId = randomUUID();
const directory = join(root, 'artifacts', `frida-consumption-service-${profile}-${runId}`);
const snapshot = join(directory, 'snapshot'),
  tools = join(directory, 'tools');
const report = {
  timestamp: new Date().toISOString(),
  run_id: runId,
  profile,
  passed: false,
  checks: [],
  requests: [],
  jobs: [],
  tools: [],
  submissions: [],
  scope: '实际前端工厂、真实宿主HTTP/MCP与Frida插件；固定假工具不代表真实设备、注入或远端进程退出',
  limitations: [
    'OS等待句柄仅确认工具及父插件直接退出，不证明派生树或远端进程',
    'OWNED/CLEAN是独立黄金回执',
    '未连接ADB/su/Frida/Java或设备',
    'Node实际工厂消费不替代浏览器或正式TGZ/npx',
  ],
};
await mkdir(snapshot, { recursive: true });
let host,
  frida,
  JobWaitFailure,
  stage = '冻结实际输入';
const context = { report, tools, calls: [] };
const active = () => AbortSignal.timeout(20000);

async function recordTicket(ticket, status, input) {
  const entry = {
    case_id: ticket.operation,
    job_id: ticket.id,
    operation: ticket.operation,
    input,
    expected_status: status,
  };
  const info = await sharedJob(host.client, entry);
  assert.equal(info.status, status);
  const events = await jobEvents(host.client, entry);
  assert.ok(!report.jobs.some((job) => job.id === info.id));
  assert.match(ticket.submitLogId, /^[a-f\d-]{36}$/);
  report.jobs.push({
    id: info.id,
    operation: info.operation,
    status,
    input,
    history: info,
    events,
    submit_log_id: ticket.submitLogId,
  });
  return ticket;
}

async function recordOutcome(outcome, input) {
  assert.match(outcome.logId, /^[a-f\d-]{36}$/);
  const ticket = {
    id: outcome.job.id,
    operation: outcome.job.operation,
    submitLogId: outcome.submitLogId,
  };
  await recordTicket(ticket, 'succeeded', input);
  assert.deepEqual(report.jobs.at(-1).history.result, outcome.data);
  return ticket;
}

async function observed(run, ordinals) {
  const promise = run();
  promise.catch(() => {});
  const calls = [];
  for (const ordinal of ordinals) {
    const call = await beginTool(context, ordinal);
    calls.push(call);
    await releaseTool(context, call);
  }
  const outcome = await promise;
  await finishTools(context, calls);
  return outcome;
}

async function download(outcome, filename, expected) {
  const response = await frida.download(outcome.data, filename, active());
  assert.ok(response.logId);
  const bytes = Buffer.from(await response.data.arrayBuffer());
  const artifact = outcome.data.artifacts.find((item) => item.filename === filename);
  assert.ok(artifact);
  assert.equal(bytes.length, artifact.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  if (expected) assert.deepEqual(bytes, expected);
  if (filename === 'operation.json') assert.deepEqual(JSON.parse(bytes), outcome.data.result);
  report.downloads ??= [];
  report.downloads.push({
    artifact_id: artifact.id,
    filename,
    bytes: bytes.length,
    sha256: artifact.sha256,
    log_id: response.logId,
  });
}

try {
  assert.equal(process.platform, 'win32');
  const inputRoot = frozen ? resolve(frozen) : join(root, 'backend/target', profile);
  const paths = [
    join(inputRoot, 'apk-server' + suffix),
    join(inputRoot, 'deviceforge-frida-plugin' + suffix),
    join(frozen ? inputRoot : join(root, 'backend/plugins/frida'), 'manifest.json'),
    toolSource,
    fileURLToPath(import.meta.url),
    join(root, 'scripts/frida-consumption-smoke/fixtures.mjs'),
    join(root, 'scripts/frida-consumption-smoke/evidence.mjs'),
    join(root, 'backend/plugins/frida/tests/fixtures/tool.rs'),
    process.execPath,
    join(root, 'artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe'),
  ];
  const production = await readdir(join(root, 'backend/plugins/frida/src'), {
    recursive: true,
    withFileTypes: true,
  });
  paths.push(
    ...production
      .filter((entry) => entry.isFile() && /\.(rs|js)$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name)),
  );
  const frontendPaths = await frontendSources(root);
  report.frontend_before = await Promise.all(frontendPaths.map(fileIdentity));
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), [
    ...paths,
    ...frontendPaths,
  ]);
  const names = ['apk-server' + suffix, 'deviceforge-frida-plugin' + suffix, 'manifest.json'];
  report.snapshots = [];
  for (const [index, name] of names.entries()) {
    await copyFile(paths[index], join(snapshot, name));
    const original = await fileIdentity(paths[index]),
      actual = await fileIdentity(join(snapshot, name));
    assert.equal(actual.sha256, original.sha256);
    report.snapshots.push({ original, actual });
  }
  await prepareTools(tools);
  const tool = join(tools, 'frida-tool' + suffix);
  await copyFile(toolSource, tool);
  assert.equal((await fileIdentity(tool)).sha256, (await fileIdentity(toolSource)).sha256);
  context.toolBinary = tool;
  context.pluginBinary = join(snapshot, names[1]);
  context.probeBinary = join(snapshot, 'process-probe.exe');
  await copyFile(paths[9], context.probeBinary);
  assert.equal(
    (await fileIdentity(context.probeBinary)).sha256,
    (await fileIdentity(paths[9])).sha256,
  );
  const template = join(snapshot, 'permissions-template.js');
  await copyFile(join(root, 'backend/plugins/frida/src/permissions.js'), template);
  assert.equal(
    (await fileIdentity(template)).sha256,
    (await fileIdentity(join(root, 'backend/plugins/frida/src/permissions.js'))).sha256,
  );
  context.permissionBytes = permissionScript(await readFile(template, 'utf8'));
  const fixturePaths = [
    tool,
    context.probeBinary,
    template,
    ...Array.from({ length: 11 }, (_, index) => index + 1).flatMap((index) =>
      ['stdout-', 'stderr-', 'code-'].map((prefix) => join(tools, prefix + index)),
    ),
  ];
  report.fixture_inputs_before = await Promise.all(fixturePaths.map(fileIdentity));
  const scratch = join(directory, 'scratch');
  await mkdir(scratch);
  context.scratch = scratch;
  const config = join(snapshot, 'frida.config.json');
  await writeFile(
    config,
    JSON.stringify({
      format_version: 1,
      tools: { adb: tool, frida: tool, frida_ps: tool },
      scratch_root: scratch,
    }),
  );
  stage = '独占宿主与六贡献';
  host = await prepareHost({
    root,
    binary: join(snapshot, names[0]),
    directory: join(directory, 'data'),
    report,
    port: await reservePort(),
  });
  await host.ready();
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json')));
  assert.equal(manifest.operations.length, 6);
  manifest.executable = join(snapshot, names[1]);
  manifest.args = ['--config', config];
  const deployed = join(host.plugins, 'frida');
  await mkdir(deployed);
  await writeFile(join(deployed, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  assert.equal(manifest.id, 'frida');
  assert.equal(manifest.protocol_version, 4);
  assert.deepEqual(manifest.artifacts, {
    input_fields: [],
    input_pointers: ['/input/artifact_id', '/input/script_artifact_id'],
    outputs: true,
  });
  const loaded = await host.client.post('/api/v2/plugins/frida/load');
  assert.equal(loaded.state, 'loaded');
  assert.equal(loaded.cleanup_failed, false);
  report.deployment = {
    generation: loaded.generation,
    identities: await Promise.all([config, join(deployed, 'manifest.json')].map(fileIdentity)),
  };
  const expected = manifest.operations.map((operation) => `plugin.frida.${operation.name}`).sort();
  assert.deepEqual(
    (await host.client.tools()).filter((name) => name.startsWith('plugin.frida.')).sort(),
    expected,
  );
  assert.deepEqual([...loaded.operations].sort(), expected);
  const { createApiClient } = await import('../frontend/src/shared/api/client.ts');
  const { createHttpFrida } = await import('../frontend/src/features/frida/index.ts');
  ({ JobWaitFailure } = await import('../frontend/src/shared/jobs/index.ts'));
  const client = createApiClient({
    baseUrl: host.client.base,
    transport: async (input, options) => {
      const response = await fetch(input, options),
        logId = response.headers.get('x-deviceforge-log-id');
      assert.match(logId, /^[a-f\d-]{36}$/);
      host.client.logIds.add(logId);
      const url = new URL(input instanceof Request ? input.url : String(input)),
        path = url.pathname + url.search;
      const method = options?.method ?? 'GET';
      report.requests.push({
        client_method: '实际Frida前端工厂',
        path,
        method,
        status: response.status,
        log_id: logId,
      });
      if (url.pathname === '/api/v2/jobs' && method === 'POST') {
        const request = JSON.parse(options.body),
          reply = await response.clone().json();
        assert.equal(response.status, 202);
        assert.deepEqual(reply.data.input, request.input);
        assert.equal(reply.data.operation, request.operation);
        report.submissions.push({ ...request, job_id: reply.data.id, submit_log_id: logId });
      }
      return response;
    },
  });
  frida = createHttpFrida(client, { pollIntervalMs: 5 });
  await assert.rejects(
    async () => frida.status('device-1', active()),
    (error) => error.name === 'ApiError',
  );
  assert.deepEqual(await host.client.json('/api/v2/jobs?limit=100'), []);
  await frida.refreshOperations(active());
  assert.equal(frida.snapshot().operations.length, 6);
  report.checks.push({ name: '动态六贡献、未发现零提交及真实前端目录', passed: true });

  stage = 'bin/js真实上传与下载';
  const server = await frida.uploadServer(new Blob([serverBytes]), active());
  const script = await frida.uploadScript(new Blob([scriptBytes]), active());
  for (const [metadata, bytes] of [
    [server.data, serverBytes],
    [script.data, scriptBytes],
  ]) {
    assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
    const downloaded = await client.downloadArtifact(metadata.id, active());
    assert.deepEqual(Buffer.from(await downloaded.data.arrayBuffer()), bytes);
  }
  report.checks.push({ name: '服务器与UTF8脚本实际上传、摘要和原字节', passed: true });
  stage = '六业务实时工具与黄金回执';
  const emptyInput = { device_id: 'device-1', input: {} };
  const status = await observed(() => frida.status('device-1', active()), [1]);
  const statusTicket = await recordOutcome(status, emptyInput);
  assert.deepEqual(status.data.result, statusResult);
  await download(status, 'operation.json');
  await download(status, 'frida.log');
  const processes = await observed(() => frida.processes('device-1', active()), [2]);
  await recordOutcome(processes, emptyInput);
  assert.deepEqual(processes.data.result, processesResult);
  const deployment = await observed(
    () => frida.deploy('device-1', server.data.id, active()),
    [3, 4, 5],
  );
  await recordOutcome(deployment, {
    device_id: 'device-1',
    input: { artifact_id: server.data.id },
  });
  assert.deepEqual(deployment.data.result, deploymentResult);
  const running = await observed(() => frida.runServer('device-1', 100, active()), [6, 7]);
  await recordOutcome(running, { device_id: 'device-1', input: { duration_ms: 100 } });
  assert.deepEqual(running.data.result, runningResult);
  const scriptInput = {
    package: 'com.example.app',
    mode: 'spawn',
    duration_ms: 1001,
    script_artifact_id: script.data.id,
  };
  const scripted = await observed(() => frida.runScript('device-1', scriptInput, active()), [8]);
  await recordOutcome(scripted, { device_id: 'device-1', input: scriptInput });
  assert.deepEqual(scripted.data.result, scriptResult());
  await download(scripted, 'script.js', scriptBytes);
  await download(scripted, 'notices.jsonl', noticeBytes);
  const permissionInput = {
    package: 'com.example.app',
    mode: 'attach',
    duration_ms: 100,
    modules: ['camera'],
    show_log: false,
  };
  const permissions = await observed(
    () => frida.analyzePermissions('device-1', permissionInput, active()),
    [9],
  );
  await recordOutcome(permissions, { device_id: 'device-1', input: permissionInput });
  assert.deepEqual(permissions.data.result, scriptResult(true));
  await download(permissions, 'permissions.js', context.permissionBytes);
  report.checks.push({ name: '六业务实际工厂、HTTP/MCP同Job、黄金回执和授权副本', passed: true });

  stage = 'MCP真实提交与原Job恢复';
  const submitted = await host.client.tool('plugin.frida.processes', emptyInput);
  assert.deepEqual(submitted.input, emptyInput);
  const mcpLogId = report.last_request.log_id;
  assert.ok(mcpLogId);
  const mcpCall = await beginTool(context, 10);
  await releaseTool(context, mcpCall);
  const observedJob = await poll(
    () => host.client.job(submitted.id),
    (job) => ['succeeded', 'failed', 'cancelled'].includes(job.status),
    'Frida MCP任务终态',
  );
  assert.equal(observedJob.status, 'succeeded');
  const mcpOutcome = await frida.resumeProcesses(
    { id: observedJob.id, operation: observedJob.operation, submitLogId: mcpLogId },
    active(),
  );
  await recordOutcome(mcpOutcome, emptyInput);
  assert.deepEqual(mcpOutcome.data.result, processesResult);
  await finishTools(context, [mcpCall]);
  report.checks.push({ name: 'MCP提交与前端原Job恢复', passed: true });

  stage = '在途等待中断与显式取消';
  const controller = new AbortController();
  const pending = frida
    .runScript('device-1', { ...scriptInput, duration_ms: 120000 }, controller.signal)
    .then(
      () => assert.fail('中断等待不得返回成功'),
      (error) => error,
    );
  const cancelledCall = await beginTool(context, 11);
  controller.abort();
  const interrupted = await pending;
  assert.ok(interrupted instanceof JobWaitFailure);
  const cancelledTicket = {
    id: interrupted.job.id,
    operation: interrupted.job.operation,
    submitLogId: interrupted.submitLogId,
  };
  assert.equal(cancelledTicket.operation, 'plugin.frida.script.run');
  await frida.cancel(cancelledTicket, active());
  const cancelled = await poll(
    () => host.client.job(cancelledTicket.id),
    (job) => job.status === 'cancelled',
    'Frida明确取消终态',
  );
  assert.deepEqual(await host.client.tool('deviceforge.get_job', { id: cancelled.id }), cancelled);
  assert.equal(cancelled.result, null);
  await recordTicket(cancelledTicket, 'cancelled', {
    device_id: 'device-1',
    input: { ...scriptInput, duration_ms: 120000 },
  });
  await finishTools(context, [cancelledCall], true);
  report.checks.push({ name: '中断等待保票据、显式取消和同Job终态', passed: true });

  stage = '卸载后历史产物与零重发';
  const unloaded = await host.client.post('/api/v2/plugins/frida/unload');
  assert.equal(unloaded.state, 'unloaded');
  assert.equal(unloaded.cleanup_failed, false);
  assert.ok(!(await host.client.tools()).some((name) => name.startsWith('plugin.frida.')));
  await frida.refreshOperations(active());
  assert.equal(frida.snapshot().operations.length, 0);
  const history = await frida.resumeStatus(statusTicket, active());
  assert.deepEqual(history.data, status.data);
  await assert.rejects(
    async () => frida.status('device-1', active()),
    (error) => error.name === 'ApiError',
  );
  assert.equal((await host.client.json('/api/v2/jobs?limit=100')).length, 8);
  assert.equal(report.submissions.length, 7);
  for (const job of report.jobs) {
    const entry = {
      case_id: job.operation,
      job_id: job.id,
      operation: job.operation,
      input: job.input,
      expected_status: job.status,
    };
    assert.deepEqual(await sharedJob(host.client, entry), job.history);
    assert.deepEqual(await jobEvents(host.client, entry), job.events);
  }
  await download(history, 'operation.json');
  await verifyTools(tools, report);
  report.checks.push({ name: '卸载撤销、历史与产物保留且零重发', passed: true });
  stage = '实际身份日志与正常退出';
  await host.shutdown();
  await host.verifyIdentity();
  await verifyLogs(directory, host, report);
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), [
    ...paths,
    ...frontendPaths,
  ]);
  report.frontend_after = await Promise.all(frontendPaths.map(fileIdentity));
  assert.deepEqual(report.inputs_after, report.inputs_before);
  assert.deepEqual(report.frontend_after, report.frontend_before);
  report.snapshots_after = await Promise.all(
    report.snapshots.map((entry) => fileIdentity(entry.actual.path)),
  );
  assert.deepEqual(
    report.snapshots_after,
    report.snapshots.map((entry) => entry.actual),
  );
  report.fixture_inputs_after = await Promise.all(fixturePaths.map(fileIdentity));
  assert.deepEqual(report.fixture_inputs_after, report.fixture_inputs_before);
  report.deployment.identities_after = await Promise.all(
    report.deployment.identities.map((entry) => fileIdentity(entry.path)),
  );
  assert.deepEqual(report.deployment.identities_after, report.deployment.identities);
  report.checks.push({ name: '输入字节稳定、日志关联和正常退出释放监听', passed: true });
  report.passed = true;
} catch (error) {
  report.failure_stage = stage;
  report.failure = {
    name: error.name,
    code: error.code ?? null,
    message: String(error.message).split('\n')[0].slice(0, 200),
    locations: String(error.stack)
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .slice(0, 6),
  };
  process.exitCode = 1;
} finally {
  frida?.dispose();
  try {
    await host?.finish();
  } catch (error) {
    report.cleanup_failure = { name: error.name, code: error.code ?? null };
    report.passed = false;
    process.exitCode = 1;
  }
  try {
    await finishPendingProbes(report);
  } catch (error) {
    report.probe_cleanup_failure = { name: error.name, code: error.code ?? null };
    report.passed = false;
    process.exitCode = 1;
  }
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      report: join(directory, 'report.json'),
      passed: report.passed,
      checks: report.checks.length,
      jobs: report.jobs.length,
    }),
  );
}
