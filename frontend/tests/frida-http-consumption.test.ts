import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrida, createHttpFrida } from '../src/features/frida/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { ArtifactDto, OperationDto } from '../src/services/api/index.ts';
import type { ArtifactAccess } from '../src/plugin-sdk/index.ts';
import type { JobGateway, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import { JobWaitFailure } from '../src/shared/jobs/index.ts';
import { requireFridaInput } from '../src/features/frida/utils/rules.ts';
import { decodeDeployment, decodeProcesses, decodeScript, decodeServerRun, decodeStatus } from '../src/features/frida/utils/results.ts';
import type { FridaPermissionsInput } from '../src/features/frida/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const actions = ['server.deploy', 'server.status', 'server.run', 'processes', 'script.run', 'permissions.analyze'];
const operation = (action: string) => `plugin.frida.${action}`;
function definitions(): OperationDto[] {
  return actions.map((action) => ({ id: operation(action), title: action, input_schema: { type: 'object', additionalProperties: false } }));
}
function scriptResult(changes: Record<string, unknown> = {}) {
  return { package: 'com.demo.app', mode: 'spawn', duration_requested_ms: 1001, cli_timeout_seconds: 2, loaded: true, resume: 'cli_default', notice_count: 1,
    hook_summary: [], cleanup: 'direct_cli_confirmed', target_process_cleanup: 'not_claimed', ...changes };
}
function result(action: string): unknown {
  switch (action) {
    case 'server.deploy': return { deployed: true, version_output: '16.7.0', root_required: true };
    case 'server.status': return { installed: true, running: true, pids: [991], version_output: '16.7.0', ownership: 'observed_only' };
    case 'server.run': return { pid: 992, process_start_ticks: 123, duration_ms: 1001, cleanup: 'confirmed', ownership: 'invocation' };
    case 'processes': return { source: 'frida-ps --json', processes: [{ pid: 23, name: '中文进程' }] };
    case 'permissions.analyze': return scriptResult({ hook_summary: [{ type: 'summary', installed_overloads: 1, missing_methods: 1 }] });
    default: return scriptResult();
  }
}
function metadata(filename: string, changes: Partial<ArtifactDto> = {}): ArtifactDto {
  return { id: `artifact-${filename}`, filename, media_type: 'application/octet-stream', size: 1, created_at: 1, sha256: 'a'.repeat(64), ...changes };
}
function envelope(action: string, value = result(action)) {
  const names = ['operation.json', 'frida.log'];
  if (action === 'script.run') names.push('script.js', 'notices.jsonl');
  if (action === 'permissions.analyze') names.push('permissions.js', 'notices.jsonl');
  return { result: value, artifacts: names.map((name) => metadata(name)) };
}
function gateway(value: unknown = envelope('server.status'), changes: Partial<JobGateway> = {}): JobGateway {
  return {
    submit: async (id) => ({ data: { id: 'job-1', operation: id, status: 'succeeded', result: value }, logId: 'submit-log' }),
    getJob: async () => ({ data: { id: 'job-1', operation: operation('server.status'), status: 'succeeded', result: value }, logId: 'query-log' }),
    cancelJob: async () => ({ data: { id: 'job-1', operation: operation('server.status'), status: 'cancelled' }, logId: 'cancel-log' }),
    ...changes,
  };
}
const artifactAccess: ArtifactAccess = {
  upload: async () => { throw new Error('本用例不上传'); },
  download: async () => { throw new Error('本用例不下载'); },
};
function input(action: string) {
  if (action === 'server.deploy') return { device_id: 'device-1', input: { artifact_id: 'server-1' } };
  if (action === 'server.run') return { device_id: 'device-1', input: { duration_ms: 1001 } };
  if (action === 'script.run') return { device_id: 'device-1', input: { package: 'com.demo.app', mode: 'spawn', duration_ms: 1001, script_artifact_id: 'script-1' } };
  if (action === 'permissions.analyze') return { device_id: 'device-1', input: { package: 'com.demo.app', mode: 'spawn', duration_ms: 1001 } };
  return { device_id: 'device-1', input: {} };
}

test('真实HTTP动态六目录与封套，任务日志、固定产物和清理观察原样消费', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (request, init) => {
    const url = requestUrl(request); const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/operations')) return success(definitions(), 'catalog-log');
    if (typeof body === 'object' && body !== null && 'operation' in body && typeof body.operation === 'string') {
      return success({ id: 'job-1', operation: body.operation, input: 'input' in body ? body.input : {}, created_at: 1, status: 'succeeded', result: envelope(body.operation.slice('plugin.frida.'.length)) }, 'task-log');
    }
    throw new Error('未声明的HTTP请求');
  } });
  const frida = createHttpFrida(client, { pollIntervalMs: 0 });
  assert.throws(() => frida.status('device-1', signal()), ApiError);
  await frida.refreshOperations(signal());
  const outputs = [
    await frida.deploy('device-1', 'server-1', signal()),
    await frida.status('device-1', signal()),
    await frida.runServer('device-1', 1001, signal()),
    await frida.processes('device-1', signal()),
    await frida.runScript('device-1', { package: 'com.demo.app', mode: 'spawn', duration_ms: 1001, script_artifact_id: 'script-1' }, signal()),
    await frida.analyzePermissions('device-1', { package: 'com.demo.app', mode: 'spawn', duration_ms: 1001 }, signal()),
  ];
  assert.deepEqual(requests.slice(1).map((request) => request.body), actions.map((action) => ({ operation: operation(action), input: input(action) })));
  assert.ok(outputs.every((output) => output.submitLogId === 'task-log' && output.logId === 'task-log'));
  assert.equal(frida.snapshot().operations.length, 6);
  assert.equal(frida.snapshot().logId, 'catalog-log');
  assert.ok(Object.isFrozen(outputs[5]?.data.result));
  assert.ok(Object.isFrozen(outputs[5]?.data.artifacts));
  frida.dispose();
});

test('动态目录失败撤销入口，取消等待不取消服务器且历史恢复不重提', async () => {
  let submissions = 0; let cancels = 0; let failed = false;
  const frida = createFrida(gateway(envelope('server.status'), {
    submit: async (id) => { submissions++; return { data: { id: 'job-1', operation: id, status: 'running' }, logId: 'submit-log' }; },
    getJob: async () => ({ data: { id: 'job-1', operation: operation('server.status'), status: 'succeeded', result: envelope('server.status') }, logId: 'resumed-log' }),
    cancelJob: async () => { cancels++; throw new Error('禁止自动cancel'); },
  }), artifactAccess, { pollIntervalMs: 10000, operations: { list: async () => { if (failed) throw new ApiError('http', 'missing_plugin', '不可用', 503, 'catalog-error-log'); return { data: definitions(), logId: 'catalog-log' }; } } });
  await frida.refreshOperations(signal());
  const controller = new AbortController();
  const waiting = frida.status('device-1', controller.signal);
  await new Promise((resolve) => setImmediate(resolve)); controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.job.operation === operation('server.status') && error.submitLogId === 'submit-log');
  failed = true; await assert.rejects(frida.refreshOperations(signal()), ApiError);
  assert.throws(() => frida.status('device-1', signal()), ApiError);
  const resumed = await frida.resumeStatus({ id: 'job-1', operation: operation('server.status'), submitLogId: 'submit-log' }, signal());
  assert.equal(resumed.logId, 'resumed-log'); assert.equal(submissions, 1); assert.equal(cancels, 0);
  frida.dispose();
});

test('设备首字符、唯一模块、空module、控制符和UTF8字节限额沿真实后端', () => {
  for (const device of ['.device', '_device', ':5555', '-device', '设备', 'a'.repeat(256)]) assert.throws(() => requireFridaInput('server.status', device, {}), ApiError);
  for (const device of ['device-1', 'host:5555', 'a'.repeat(255)]) requireFridaInput('server.status', device, {});
  const base = { package: 'com.demo.app', mode: 'spawn', duration_ms: 100 };
  const hook = { class: 'android.example.Class$Inner', method: '$init', action: '行动', messages: '说明' };
  for (const input of [
    { ...base, modules: ['camera', 'camera'] }, { ...base, modules: null }, { ...base, hooks: null }, { ...base, show_log: null },
    { ...base, hooks: [{ ...hook, module: '\u0085' }] }, { ...base, hooks: [{ ...hook, module: '\ud800' }] },
    { ...base, hooks: [{ ...hook, args: ['文'.repeat(683)] }] }, { ...base, hooks: [{ ...hook, messages: '\udc00' }] },
    { ...base, hooks: [{ ...hook, action: '文'.repeat(171) }] }, { ...base, hooks: [{ ...hook, expression: '非法附加字段' }] },
  ]) assert.throws(() => requireFridaInput('permissions.analyze', 'device-1', input), ApiError);
  requireFridaInput('permissions.analyze', 'device-1', { ...base, hooks: [{ ...hook, module: '', args: ['文'.repeat(682)] }], show_log: false });
  requireFridaInput('server.deploy', 'device-1', { artifact_id: '文'.repeat(42) });
  for (const artifact_id of ['', '文'.repeat(43), '\ud800', '\u007f']) assert.throws(() => requireFridaInput('server.deploy', 'device-1', { artifact_id }), ApiError);
});

test('调用输入建立冻结副本，调用者修改数组和包名不改变提交或结果归属', async () => {
  const submitted: JsonData[] = [];
  const waiting = deferred<{ data: TaskRecord; logId: string }>();
  const frida = createFrida(gateway(undefined, { submit: async (_operation, input) => { submitted.push(input); return waiting.promise; } }), artifactAccess);
  const original = { package: 'com.demo.app', mode: 'spawn', duration_ms: 1001, modules: ['camera'], hooks: [{ class: 'vendor.Class', method: 'read', action: '读取', messages: '说明', args: ['exact'] }] } satisfies FridaPermissionsInput;
  const outcome = frida.analyzePermissions('device-1', original, signal());
  original.package = 'com.other.app'; original.hooks[0]?.args.push('late'); original.modules.push('camera');
  assert.deepEqual(submitted, [{ device_id: 'device-1', input: { package: 'com.demo.app', mode: 'spawn', duration_ms: 1001, modules: ['camera'], hooks: [{ class: 'vendor.Class', method: 'read', action: '读取', messages: '说明', args: ['exact'] }] } }]);
  assert.ok(Object.isFrozen(submitted[0]));
  waiting.resolve({ data: { id: 'job-1', operation: operation('permissions.analyze'), status: 'succeeded', result: envelope('permissions.analyze') }, logId: 'immutable-submit-log' });
  const completed = await outcome;
  assert.equal(completed.data.result.package, 'com.demo.app');
  assert.ok(Object.isFrozen(completed.data.result.hook_summary[0]));
  frida.dispose();
});

test('私有结果拒绝额外字段、虚假所有权和不安全ticks，保留真实终态日志', () => {
  const bad: { action: string; value: unknown; decode: (value: unknown, logId: string) => unknown }[] = [
    { action: 'server.deploy', value: { deployed: true, version_output: '', root_required: true, device_id: '编造设备' }, decode: decodeDeployment },
    { action: 'server.status', value: { installed: true, running: false, pids: [1], version_output: '', ownership: 'observed_only' }, decode: decodeStatus },
    { action: 'server.status', value: { installed: true, running: false, pids: [], version_output: '', ownership: 'invocation' }, decode: decodeStatus },
    { action: 'server.run', value: { pid: 992, process_start_ticks: 0, duration_ms: 1001, cleanup: 'confirmed', ownership: 'invocation' }, decode: (value, logId) => decodeServerRun(value, logId, 1001) },
    { action: 'server.run', value: { pid: 992, process_start_ticks: Number.MAX_SAFE_INTEGER + 1, duration_ms: 1001, cleanup: 'confirmed', ownership: 'invocation' }, decode: (value, logId) => decodeServerRun(value, logId, 1001) },
    { action: 'processes', value: { source: 'frida-ps --json', processes: [{ pid: 4294967296, name: '异常PID' }] }, decode: decodeProcesses },
    { action: 'processes', value: { source: 'frida-ps --json', processes: [{ pid: 123, name: '中文', guessed: true }] }, decode: decodeProcesses },
  ];
  for (const entry of bad) assert.throws(() => entry.decode(envelope(entry.action, entry.value), 'result-log'), (error: unknown) => error instanceof ApiError && error.logId === 'result-log');
  const scriptInput = { package: 'com.demo.app', mode: 'spawn', duration_ms: 1001 } satisfies Pick<FridaPermissionsInput, 'package' | 'mode' | 'duration_ms'>;
  for (const changes of [
    { cli_timeout_seconds: 1 }, { duration_requested_ms: 1000 }, { package: 'com.other.app' }, { resume: 'already_running' },
    { loaded: false }, { cleanup: 'unconfirmed' }, { target_process_cleanup: 'confirmed' }, { notice_count: 10001 }, { added: '禁止字段' },
  ]) assert.throws(() => decodeScript(envelope('script.run', scriptResult(changes)), 'script-log', scriptInput, false), ApiError);
  const large = envelope('server.status');
  large.artifacts[0] = metadata('operation.json', { size: 64 * 1024 * 1024 + 1 });
  assert.throws(() => decodeStatus(large, 'large-log'), ApiError);
});

test('Hook诊断按后端有界不透明JSON保留，权限只要求实际summary存在', () => {
  const expected = { package: 'com.demo.app', mode: 'spawn', duration_ms: 1001 } satisfies Pick<FridaPermissionsInput, 'package' | 'mode' | 'duration_ms'>;
  const diagnostics = [null, '厂商诊断', 7, [], { type: 'vendor', values: [false] }, { type: 'summary', installed: 1, missing: 2 }];
  const output = decodeScript(envelope('permissions.analyze', scriptResult({ hook_summary: diagnostics })), 'opaque-log', expected, true);
  assert.deepEqual(output.result.hook_summary, diagnostics);
  assert.ok(Object.isFrozen(output.result.hook_summary[4]));
  assert.throws(() => decodeScript(envelope('permissions.analyze', scriptResult({ hook_summary: [{ type: 'installed' }] })), 'missing-summary-log', expected, true), ApiError);
  assert.throws(() => decodeScript(envelope('script.run', scriptResult({ hook_summary: Array.from({ length: 4098 }, () => null) })), 'diagnostics-limit-log', expected, false), ApiError);
  assert.equal(decodeScript(envelope('script.run', scriptResult({ hook_summary: [null] })), null, expected, false).result.hook_summary.length, 1);
});

test('HTTP上传显式映射SDK元数据，下载保持原字节并核对摘要与日志', async () => {
  const blob = new Blob(['console.log("设备");'], { type: 'text/javascript' });
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const meta = metadata('script.js', { size: blob.size, sha256: digest, media_type: 'text/javascript', created_at: 99 });
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (request, init) => {
    const url = requestUrl(request);
    if (url.pathname === '/api/v2/artifacts') {
      assert.equal(url.searchParams.get('filename'), 'script.js'); assert.equal(init?.body, blob);
      return success(meta, 'upload-real-log', 201);
    }
    assert.equal(url.pathname, '/api/v2/artifacts/artifact-script.js/content');
    return new Response(blob, { headers: { 'content-type': 'text/javascript', 'x-deviceforge-log-id': 'download-real-log' } });
  } });
  const frida = createHttpFrida(client);
  const uploaded = await frida.uploadScript(blob, signal());
  assert.equal(uploaded.data.mediaType, 'text/javascript'); assert.equal(uploaded.data.createdAt, 99); assert.equal(uploaded.logId, 'upload-real-log');
  const downloaded = await frida.download({ result: {}, artifacts: [meta] }, 'script.js', signal());
  assert.deepEqual(new Uint8Array(await downloaded.data.arrayBuffer()), new Uint8Array(await blob.arrayBuffer()));
  assert.equal(downloaded.logId, 'download-real-log');
  await assert.rejects(frida.download({ result: {}, artifacts: [{ ...meta, sha256: '0'.repeat(64) }] }, 'script.js', signal()), (error: unknown) => error instanceof ApiError && error.logId === 'download-real-log');
  frida.dispose();
});

test('目录旧成功/拒绝与dispose均不恢复失效贡献，重复ID和错schema拒绝', async () => {
  for (const rejects of [false, true]) {
    const delayed = deferred<{ data: unknown; logId: string }>();
    let calls = 0;
    const frida = createFrida(gateway(), artifactAccess, { operations: { list: async () => ++calls === 1 ? delayed.promise : { data: [], logId: 'current-catalog-log' } } });
    const old = frida.refreshOperations(signal());
    const current = await frida.refreshOperations(signal());
    await assert.rejects(old, ApiError);
    if (rejects) delayed.reject(new Error('晚到失败')); else delayed.resolve({ data: definitions(), logId: 'late-catalog-log' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(current.data, []); assert.equal(frida.snapshot().logId, 'current-catalog-log');
    assert.throws(() => frida.status('device-1', signal()), ApiError);
    frida.dispose();
  }
  for (const data of [[...definitions(), definitions()[0]], [{ id: operation('processes'), title: '进程', input_schema: { type: 'array' } }]]) {
    const frida = createFrida(gateway(), artifactAccess, { operations: { list: async () => ({ data, logId: 'invalid-catalog-log' }) } });
    await assert.rejects(frida.refreshOperations(signal()), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-catalog-log');
    assert.equal(frida.snapshot().operations.length, 0); frida.dispose();
  }
  const delayed = deferred<{ data: unknown; logId: string }>();
  const frida = createFrida(gateway(), artifactAccess, { operations: { list: async () => delayed.promise } });
  const waiting = frida.refreshOperations(signal()); frida.dispose(); await assert.rejects(waiting, ApiError);
  delayed.resolve({ data: definitions(), logId: 'disposed-catalog-log' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frida.snapshot().operations.length, 0);
});

test('固定产物名、元数据与请求回显逐项验证，不以成功任务包装替代业务成功', async () => {
  const wrongOutputs: unknown[] = [
    { result: result('server.status'), artifacts: [metadata('operation.json')] },
    { result: result('server.status'), artifacts: [metadata('operation.json'), metadata('frida.log'), metadata('extra.log')] },
    { result: result('server.status'), artifacts: [metadata('operation.json'), metadata('frida.log', { id: 'artifact-operation.json' })] },
    { result: result('server.status'), artifacts: [metadata('operation.json', { sha256: 'invalid' }), metadata('frida.log')] },
    { ...envelope('server.status'), error: null },
  ];
  for (const value of wrongOutputs) {
    const frida = createFrida(gateway(value), artifactAccess);
    await assert.rejects(frida.status('device-1', signal()), (error: unknown) => error instanceof ApiError && error.logId === 'submit-log');
    frida.dispose();
  }
  const frida = createFrida(gateway(), artifactAccess);
  const ticket = { id: 'job-1', operation: operation('server.status'), submitLogId: 'known-submit-log' };
  assert.throws(() => frida.resumeRun(ticket, 1001, signal()), ApiError);
  assert.throws(() => frida.queryJob({ ...ticket, operation: 'plugin.other.run' }, signal()), ApiError);
  assert.throws(() => frida.cancel({ ...ticket, operation: 'plugin.other.run' }, signal()), ApiError);
  assert.equal((await frida.queryJob(ticket, signal())).logId, 'query-log');
  assert.equal((await frida.cancel(ticket, signal())).logId, 'cancel-log');
  frida.dispose();
});

test('dispose及时结束忽略信号的在途任务，晚到结果无可交付业务成功', async () => {
  const delayed = deferred<{ data: TaskRecord; logId: string }>();
  const submitted = deferred<void>();
  const frida = createFrida(gateway(undefined, {
    submit: async (id) => { submitted.resolve(); return { data: { id: 'job-1', operation: id, status: 'running' }, logId: 'running-submit-log' }; },
    getJob: async () => delayed.promise,
  }), artifactAccess, { pollIntervalMs: 0 });
  const waiting = frida.status('device-1', signal());
  await submitted.promise; await new Promise((resolve) => setImmediate(resolve));
  frida.dispose();
  await assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.submitLogId === 'running-submit-log');
  delayed.resolve({ data: { id: 'job-1', operation: operation('server.status'), status: 'succeeded', result: envelope('server.status') }, logId: 'late-success-log' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frida.snapshot().operations.length, 0);
});

