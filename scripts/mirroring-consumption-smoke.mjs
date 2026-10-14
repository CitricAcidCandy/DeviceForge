import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { inputManifest } from './harmony-device-smoke/evidence.mjs';
import { poll } from './device-provider/client.mjs';
import { sharedJob, jobEvents } from './ordinary-deadline-http/client.mjs';
import {
  basic,
  mcpInput,
  recordOperation,
  recording,
  selected,
  sourceContract,
  statusOperation,
  version,
  video,
} from './mirroring-consumption-smoke/contracts.mjs';
import {
  exactTools,
  finished,
  finishPendingProbes,
  prepareTools,
  release,
  started,
} from './mirroring-consumption-smoke/fixtures.mjs';
import { download, failure, logs } from './mirroring-consumption-smoke/evidence.mjs';

const argumentsList = process.argv.slice(2);
assert.ok(
  argumentsList.every(
    (value) => value.startsWith('--frozen-input=') || value.startsWith('--tool='),
  ),
);
assert.ok(argumentsList.filter((value) => value.startsWith('--frozen-input=')).length <= 1);
assert.ok(argumentsList.filter((value) => value.startsWith('--tool=')).length <= 1);
const root = fileURLToPath(new URL('../', import.meta.url));
const option = (name) =>
  argumentsList.find((value) => value.startsWith(name + '='))?.slice(name.length + 1);
const frozen = resolve(
  option('--frozen-input') ?? join(root, 'artifacts/mirroring-consumption-frozen-debug-20261012'),
);
const sourceTool = resolve(
  option('--tool') ??
    join(root, 'artifacts/mirroring-consumption-fixtures-20261012/mirroring-tool.exe'),
);
const runId = randomUUID(),
  directory = join(root, 'artifacts', 'mirroring-consumption-service-debug-' + runId);
const snapshot = join(directory, 'snapshot');
const report = {
  timestamp: new Date().toISOString(),
  run_id: runId,
  profile: 'debug',
  passed: false,
  checks: [],
  jobs: [],
  tools: [],
  requests: [],
  downloads: [],
  history_phases: [],
  scope: '真实冻结Rust宿主与mirroring插件、实际Node前端工厂、HTTP/MCP公开Job及可控scrcpy直接OS退出',
  limitations: [
    '36字节合成MP4容器不证明真实H264编码、完整解码、可播放视频或FPS/分辨率',
    'runtime.status只检查配置工具，不证明设备连通',
    '未执行真实scrcpy/ADB、真机、浏览器直播/音频/控制/重连',
    'OS句柄仅确认本地工具及父插件直接退出，不证明派生树、远端资源、跨平台、release、TGZ/npx或性能',
  ],
};
const context = { root, directory, report, calls: [] };
await mkdir(snapshot, { recursive: true });
let host,
  frontend,
  stage = '冻结真实输入';

async function frontendInputs() {
  const entries = [
    'frontend/src/features/mirroring/index.ts',
    'frontend/src/shared/api/client.ts',
    'frontend/src/shared/jobs/index.ts',
  ];
  const manifests = await Promise.all(entries.map((path) => inputManifest(join(root, path), [])));
  return [...new Map(manifests.flat().map((value) => [value.path, value])).values()].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
}

async function recordTicket(ticket, input, status = 'succeeded') {
  const entry = report.jobs.find((value) => value.job_id === ticket.id);
  assert.ok(entry);
  assert.equal(entry.operation, ticket.operation);
  assert.deepEqual(entry.input, input);
  assert.equal(entry.submit_log_id, ticket.submitLogId);
  entry.expected_status = status;
  await poll(
    () => host.client.job(ticket.id),
    (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status),
    '录像Job终态',
  );
  entry.history = await sharedJob(host.client, entry);
  assert.equal(entry.history.status, status);
  entry.events = await jobEvents(host.client, entry);
  return entry;
}

async function recordOutcome(outcome, input) {
  const ticket = {
    id: outcome.job.id,
    operation: outcome.job.operation,
    submitLogId: outcome.submitLogId,
  };
  const entry = await recordTicket(ticket, input);
  assert.deepEqual(
    entry.history.result,
    outcome.job.operation === statusOperation
      ? { result: outcome.data, artifacts: [] }
      : outcome.data,
  );
  return ticket;
}

async function recordRound(input, ordinal) {
  const promise = frontend.record(input, AbortSignal.timeout(20000));
  promise.catch(() => {});
  const call = await started(context, ordinal, input);
  await release(call);
  const outcome = await promise;
  assert.deepEqual(outcome.data.result, recording(input));
  const ticket = await recordOutcome(outcome, input);
  await download(context, outcome.data, frontend);
  await finished(context, call);
  return { outcome, ticket };
}

async function history(phase) {
  for (const entry of report.jobs) {
    assert.deepEqual(await sharedJob(host.client, entry), entry.history);
    assert.deepEqual(await jobEvents(host.client, entry), entry.events);
  }
  report.history_phases.push({ phase, jobs: report.jobs.length });
}

try {
  assert.equal(process.platform, 'win32');
  const names = ['apk-server.exe', 'deviceforge-mirroring-plugin.exe', 'manifest.json'];
  const sources = [
    ...names.map((name) => join(frozen, name)),
    sourceTool,
    join(root, 'artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe'),
  ];
  report.frontend_inputs_before = await frontendInputs();
  const production = await readdir(join(root, 'backend/plugins/mirroring/src'), {
    recursive: true,
    withFileTypes: true,
  });
  const inputs = [
    ...sources,
    process.execPath,
    join(root, 'scripts/mirroring-consumption-smoke/fake-tool.rs'),
    ...production
      .filter((value) => value.isFile() && value.name.endsWith('.rs'))
      .map((value) => join(value.parentPath, value.name)),
    ...report.frontend_inputs_before.map((value) => value.path),
  ];
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), inputs);
  report.snapshots = [];
  for (const [index, name] of [...names, 'fake-tool.exe', 'process-probe.exe'].entries()) {
    const target = join(snapshot, name);
    const original = await fileIdentity(sources[index]);
    await copyFile(sources[index], target);
    const actual = await fileIdentity(target);
    assert.equal(actual.sha256, original.sha256);
    report.snapshots.push({ original, actual });
  }
  context.probeBinary = join(snapshot, 'process-probe.exe');
  context.pluginBinary = join(snapshot, names[1]);
  await prepareTools(context, join(snapshot, 'fake-tool.exe'));
  assert.equal(video.length, 36);
  assert.equal(video.readUInt32BE(0), 24);
  assert.equal(video.subarray(4, 8).toString('ascii'), 'ftyp');
  assert.equal(video.readUInt32BE(24), 12);
  assert.equal(video.subarray(28, 32).toString('ascii'), 'mdat');
  const config = join(snapshot, 'mirroring.config.json');
  await writeFile(
    config,
    JSON.stringify({ format_version: 1, scrcpy: context.toolBinary, adb: context.adbBinary }),
    { flag: 'wx' },
  );
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json')));
  sourceContract(manifest);
  manifest.executable = context.pluginBinary;
  manifest.args = ['--config', config];
  stage = '独占宿主与双贡献';
  context.authorizedTemporaryRoot = join(directory, 'authorized-temporary');
  await mkdir(context.authorizedTemporaryRoot);
  const temporaryVariables = ['TEMP', 'TMP', 'TMPDIR'];
  const inheritedTemporary = new Map(temporaryVariables.map((name) => [name, process.env[name]]));
  for (const name of temporaryVariables) process.env[name] = context.authorizedTemporaryRoot;
  try {
    host = await prepareHost({
      root,
      binary: join(snapshot, names[0]),
      directory: join(directory, 'data'),
      report,
      port: await reservePort(),
    });
  } finally {
    for (const [name, value] of inheritedTemporary) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  report.authorized_temporary_root = context.authorizedTemporaryRoot;
  context.host = host;
  await host.ready();
  assert.ok(!(await host.client.tools()).includes(recordOperation));
  const deployed = join(host.plugins, 'mirroring');
  await mkdir(deployed);
  await writeFile(join(deployed, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  const loaded = await host.client.post('/api/v2/plugins/mirroring/load');
  assert.equal(loaded.state, 'loaded');
  assert.equal(loaded.cleanup_failed, false);
  assert.deepEqual([...loaded.operations].sort(), [recordOperation, statusOperation].sort());
  report.deployment = {
    generation: loaded.generation,
    identities: await Promise.all([config, join(deployed, 'manifest.json')].map(fileIdentity)),
  };
  const { createApiClient } = await import('../frontend/src/shared/api/client.ts');
  const { createHttpMirroring } = await import('../frontend/src/features/mirroring/index.ts');
  const { JobFailure, JobWaitFailure } = await import('../frontend/src/shared/jobs/index.ts');
  const client = createApiClient({
    baseUrl: host.client.base,
    transport: async (input, options) => {
      const response = await fetch(input, options),
        logId = response.headers.get('x-deviceforge-log-id');
      assert.match(logId, /^[a-f\d-]{36}$/);
      host.client.logIds.add(logId);
      const url = new URL(input instanceof Request ? input.url : String(input)),
        method = options?.method ?? 'GET';
      report.requests.push({
        client_method: '实际投屏前端工厂',
        path: url.pathname + url.search,
        method,
        status: response.status,
        log_id: logId,
      });
      if (url.pathname === '/api/v2/jobs' && method === 'POST') {
        const body = JSON.parse(options.body),
          reply = await response.clone().json();
        assert.equal(response.status, 202);
        assert.equal(reply.data.operation, body.operation);
        assert.deepEqual(reply.data.input, body.input);
        report.jobs.push({
          case_id: body.operation,
          job_id: reply.data.id,
          operation: body.operation,
          input: body.input,
          submit_log_id: logId,
          transport: 'frontend-http',
          expected_status: 'succeeded',
        });
      }
      return response;
    },
  });
  frontend = createHttpMirroring(client, { pollIntervalMs: 5 });
  await assert.rejects(
    async () => frontend.runtimeStatus(AbortSignal.timeout(10000)),
    (error) => error.code === 'mirroring_operation_unavailable',
  );
  assert.deepEqual(await host.client.json('/api/v2/jobs?limit=100'), []);
  await frontend.refreshOperations(AbortSignal.timeout(10000));
  assert.deepEqual(
    frontend
      .snapshot()
      .operations.map((value) => value.id)
      .sort(),
    [recordOperation, statusOperation].sort(),
  );
  const operations = await host.client.json('/api/v2/operations');
  assert.deepEqual(await host.client.tool('deviceforge.list_operations', {}), operations);
  for (const id of [recordOperation, statusOperation])
    assert.deepEqual(operations.find((value) => value.id === id).execution, {
      api_version: 1,
      total_timeout_ms: 150000,
      source: 'declared',
    });
  report.checks.push({ name: '冻结黄金MP4、双贡献发现与实际前端零隐式提交', passed: true });

  stage = '实际工具状态';
  const statusPromise = frontend.runtimeStatus(AbortSignal.timeout(20000));
  statusPromise.catch(() => {});
  const statusCall = await started(context, 1);
  await release(statusCall);
  const status = await statusPromise;
  assert.deepEqual(status.data, { available: true, version, live_stream: false, recording: true });
  await recordOutcome(status, {});
  await finished(context, statusCall);
  report.checks.push({
    name: '公开工厂工具版本/空产物与真实父子退出，未宣称设备连通',
    passed: true,
  });
  stage = '缺省与选择录像';
  const base = await recordRound(basic, 2);
  const choice = await recordRound(selected, 3);
  assert.equal(Object.hasOwn(choice.outcome.data.result, 'max_size'), false);
  assert.equal(Object.hasOwn(choice.outcome.data.result, 'max_fps'), false);
  report.checks.push({ name: '前端HTTP缺省/显式参数、向上整秒与唯一MP4原字节下载', passed: true });

  stage = 'MCP录像与同Job前端恢复';
  const submitted = await host.client.tool(recordOperation, mcpInput);
  assert.equal(submitted.operation, recordOperation);
  assert.deepEqual(submitted.input, mcpInput);
  const mcpTicket = {
    id: submitted.id,
    operation: submitted.operation,
    submitLogId: report.last_request.log_id,
  };
  report.jobs.push({
    case_id: 'MCP录像',
    job_id: submitted.id,
    operation: submitted.operation,
    input: submitted.input,
    submit_log_id: mcpTicket.submitLogId,
    transport: 'mcp',
    expected_status: 'succeeded',
  });
  const mcpCall = await started(context, 4, mcpInput);
  await release(mcpCall);
  const restored = await frontend.resumeRecord(mcpTicket, mcpInput, AbortSignal.timeout(20000));
  assert.deepEqual(restored.data.result, recording(mcpInput));
  await recordOutcome(restored, mcpInput);
  await download(context, restored.data, frontend);
  await finished(context, mcpCall);
  report.checks.push({ name: 'MCP提交与真实前端原Job恢复，三秒参数及下载原字节', passed: true });

  stage = '输入与MP4资格拒绝';
  const beforeJobs = await host.client.json('/api/v2/jobs?limit=100');
  for (const input of [
    { ...basic, device_id: '-bad' },
    { ...basic, duration_ms: 999 },
    { ...basic, max_fps: 61 },
  ]) {
    await assert.rejects(
      async () => frontend.record(input, AbortSignal.timeout(10000)),
      (error) => error.code === 'invalid_mirroring_input',
    );
  }
  for (const input of [
    { ...basic, duration_ms: 999 },
    { ...basic, max_fps: 61 },
    { ...basic, instant: true },
  ]) {
    await host.client.post(
      '/api/v2/jobs',
      { operation: recordOperation, input },
      { status: 400, code: 'invalid_input' },
    );
    await host.client.tool(recordOperation, input, 'invalid_input');
  }
  assert.deepEqual(await host.client.json('/api/v2/jobs?limit=100'), beforeJobs);
  assert.equal(context.calls.length, 4);
  const bad = await host.client.post(
    '/api/v2/jobs',
    { operation: recordOperation, input: basic },
    { status: 202 },
  );
  const badTicket = {
    id: bad.id,
    operation: bad.operation,
    submitLogId: report.last_request.log_id,
  };
  report.jobs.push({
    case_id: '无效MP4头部',
    job_id: bad.id,
    operation: bad.operation,
    input: basic,
    submit_log_id: badTicket.submitLogId,
    transport: 'http',
    expected_status: 'failed',
  });
  const badCall = await started(context, 5, basic);
  await release(badCall);
  const badEntry = await recordTicket(badTicket, basic, 'failed');
  assert.equal(badEntry.history.result, null);
  assert.equal(badEntry.history.error, '依赖执行失败：工具输出不是MP4');
  await finished(context, badCall);
  report.checks.push({
    name: '前端/HTTP/MCP非法输入零Job零工具及坏MP4失败不发布/清理',
    passed: true,
  });

  stage = '等待中断与显式取消';
  const long = { ...basic, duration_ms: 120000 },
    controller = new AbortController();
  const pending = frontend.record(long, controller.signal).then(
    () => assert.fail('已中断等待不得成功'),
    (error) => error,
  );
  const cancelledCall = await started(context, 6, long);
  controller.abort();
  const interrupted = await pending;
  assert.ok(interrupted instanceof JobWaitFailure);
  const cancelledTicket = {
    id: interrupted.job.id,
    operation: interrupted.job.operation,
    submitLogId: interrupted.submitLogId,
  };
  assert.equal(cancelledTicket.operation, recordOperation);
  await frontend.cancel(cancelledTicket, AbortSignal.timeout(10000));
  const cancelled = await recordTicket(cancelledTicket, long, 'cancelled');
  assert.equal(cancelled.history.result, null);
  await finished(context, cancelledCall, true);
  report.checks.push({
    name: '中断前端等待保留票据、显式取消、OS非零退出及部分视频清理',
    passed: true,
  });

  stage = '在途卸载、撤目录、历史及原字节';
  const draining = frontend.record(long, AbortSignal.timeout(20000)).then(
    () => assert.fail('卸载在途任务不得成功'),
    (error) => error,
  );
  const unloadedCall = await started(context, 7, long);
  const unloaded = await host.client.tool('deviceforge.unload_plugin', { id: 'mirroring' });
  assert.equal(unloaded.state, 'unloaded');
  assert.equal(unloaded.cleanup_failed, false);
  const unloadFailure = await draining;
  assert.ok(unloadFailure instanceof JobFailure);
  const drainedTicket = {
    id: unloadFailure.job.id,
    operation: unloadFailure.job.operation,
    submitLogId: unloadFailure.submitLogId,
  };
  const drained = await recordTicket(drainedTicket, long, 'cancelled');
  assert.equal(drained.history.result, null);
  await finished(context, unloadedCall, true);
  assert.ok(!(await host.client.tools()).some((value) => value.startsWith('plugin.mirroring.')));
  await frontend.refreshOperations(AbortSignal.timeout(10000));
  assert.equal(frontend.snapshot().operations.length, 0);
  await history('卸载后');
  const retired = join(directory, 'mirroring-retired');
  await rename(deployed, retired);
  await history('撤离部署目录后');
  for (const item of [base.outcome, choice.outcome, restored])
    await download(context, item.data, frontend);
  const previous = report.jobs.length;
  const old = await frontend.resumeRecord(choice.ticket, selected, AbortSignal.timeout(10000));
  assert.deepEqual(old.data, choice.outcome.data);
  await assert.rejects(
    async () => frontend.record(basic, AbortSignal.timeout(10000)),
    (error) => error.code === 'mirroring_operation_unavailable',
  );
  assert.equal(report.jobs.length, previous);
  assert.equal((await host.client.json('/api/v2/jobs?limit=100')).length, previous);
  report.checks.push({
    name: '在途卸载、目录撤离、原七Job/事件/视频及前端恢复零重发',
    passed: true,
  });

  stage = '新代次重载';
  await rename(retired, deployed);
  const reloaded = await host.client.post('/api/v2/plugins/mirroring/load');
  assert.equal(reloaded.state, 'loaded');
  assert.equal(reloaded.cleanup_failed, false);
  assert.notEqual(reloaded.generation, loaded.generation);
  report.deployment.reloaded_generation = reloaded.generation;
  await frontend.refreshOperations(AbortSignal.timeout(10000));
  await history('新代次后');
  await recordRound(basic, 8);
  await exactTools(context);
  report.checks.push({ name: '新代次/原Job历史保持和实际新录像八工具退出', passed: true });
  stage = '正常退出、日志与身份';
  await host.shutdown();
  await host.verifyIdentity();
  await logs(context);
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), inputs);
  assert.deepEqual(report.inputs_after, report.inputs_before);
  report.frontend_inputs_after = await frontendInputs();
  assert.deepEqual(report.frontend_inputs_after, report.frontend_inputs_before);
  report.snapshots_after = await Promise.all(
    report.snapshots.map((value) => fileIdentity(value.actual.path)),
  );
  assert.deepEqual(
    report.snapshots_after,
    report.snapshots.map((value) => value.actual),
  );
  report.fixture_inputs_after = await Promise.all(
    report.fixture_inputs.map((value) => fileIdentity(value.path)),
  );
  assert.deepEqual(report.fixture_inputs_after, report.fixture_inputs);
  report.deployment.identities_after = await Promise.all(
    report.deployment.identities.map((value) => fileIdentity(value.path)),
  );
  assert.deepEqual(report.deployment.identities_after, report.deployment.identities);
  report.checks.push({
    name: '全部响应/唯一request_id/终态码日志关联、输入稳定及正常退出释放监听',
    passed: true,
  });
  report.passed = true;
} catch (error) {
  failure(report, error, stage);
} finally {
  frontend?.dispose();
  if (host) {
    try {
      await host.finish();
    } catch (error) {
      failure(report, error, '宿主最终清理');
    }
  }
  try {
    await finishPendingProbes(report);
  } catch (error) {
    failure(report, error, '探针最终清理');
  }
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      report: join(directory, 'report.json'),
      passed: report.passed,
      checks: report.checks.length,
      jobs: report.jobs.length,
      tools: report.tools.length,
      failure_stage: report.failure_stage,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
