import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeviceAccess, DeviceAction, DeviceCapability, DeviceDirectory, DeviceProviderInfo, DeviceRef,
  DeviceSnapshot, HostContext, HostResult, Job, Operation } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { deferred } from './fixtures.ts';
const loader = registerCompositionStartupImports();
const { createDeviceAction } = await import('../plugins/devices/src/actions.ts');
const { deviceActionReason, parseDeviceInput } = await import('../plugins/devices/src/action-rules.ts');
const { createOperationSource } = await import('../plugins/business-kit/src/platform.ts');
const { discoverAfterConnection } = await import('../plugins/devices/src/connection-observation.ts');
loader.dispose();

const reference: DeviceRef = { providerId: 'custom', generation: 'one', localId: 'same' };
const connect: DeviceCapability = { id: 'connect', version: 1, operation: 'custom.connect', scope: 'provider', access: 'write' };
const read: DeviceCapability = { id: 'probe', version: 2, operation: 'custom.probe', scope: 'device', access: 'read' };
const provider: DeviceProviderInfo = { id: 'custom', generation: 'one', version: '1',
  definition: { apiVersion: 3, platform: '不参与判定的平台名称', discoverOperation: 'custom.discover', capabilities: [connect, read] } };
const request = { provider, capability: connect, reference: null, input: { address: 'test:1234' } };
function job(operation = connect.operation, status: Job['status'] = 'succeeded'): Job {
  return { id: 'test-job', operation, status, result: { result: { value: 1 }, artifacts: [] }, error: null };
}
async function fixture() {
  const controller = new AbortController();
  let snapshot: DeviceSnapshot = { providers: [provider], directories: [], selection: reference,
    selected: { reference, state: 'online', model: '测试设备', capabilities: [{ id: read.id, version: read.version, available: true, reason: null }] } };
  let catalogue: readonly Operation[] = [connect, read].map((entry) => ({
    id: entry.operation, title: entry.id, input_schema: { type: 'object', properties: { input: {
      type: 'object', properties: entry.scope === 'provider' ? { address: { type: 'string' } } : {},
      required: entry.scope === 'provider' ? ['address'] : [],
    } } },
  }));
  const calls = { invoke: [] as DeviceAction[], get: 0, cancel: 0, operations: 0, discover: 0 };
  const deviceListeners = new Set<(snapshot: DeviceSnapshot) => void>();
  const operationListeners = new Set<(operations: readonly Operation[]) => void>();
  const implementation = {
    invoke: async (action: DeviceAction, _signal: AbortSignal): Promise<HostResult<Job>> => ({ data: job(action.capability === read.id ? read.operation : connect.operation, 'queued'), logId: 'submit-log' }),
    getJob: async (_id: string, _signal: AbortSignal): Promise<HostResult<Job>> => ({ data: job(), logId: 'result-log' }),
    discover: async (_signal: AbortSignal): Promise<HostResult<DeviceDirectory>> => ({
      data: { provider, discoveryJobId: 'discovery-job', observedAt: 1, devices: [] }, logId: 'discovery-log',
    }),
  };
  const unavailable = async (): Promise<never> => { throw new Error('单元不得访问真实设备或提交其他业务'); };
  const devices: DeviceAccess = {
    snapshot: () => snapshot,
    subscribe: (listener) => { deviceListeners.add(listener); return () => { deviceListeners.delete(listener); }; },
    select: () => { throw new Error('动作不得改选设备'); },
    refreshProviders: unavailable, refreshDirectories: unavailable,
    refreshProvider: (_id, _generation, signal) => { calls.discover++; return implementation.discover(signal); },
    invoke: (action, signal) => { calls.invoke.push(action); return implementation.invoke(action, signal); },
  };
  const context: HostContext = {
    apiVersion: 2, signal: controller.signal, devices, onDispose: (release) => release,
    listOperations: async () => { calls.operations++; return { data: catalogue, logId: 'operations-log' }; },
    subscribeOperations: (listener) => { operationListeners.add(listener); return () => { operationListeners.delete(listener); }; },
    submit: unavailable,
    getJob: (id, signal) => { calls.get++; return implementation.getJob(id, signal); },
    cancelJob: async () => { calls.cancel++; return { data: job(connect.operation, 'cancelled'), logId: 'cancel-log' }; },
  };
  const operations = createOperationSource(context);
  await operations.list(controller.signal);
  return { context, operations, devices, implementation, calls,
    listeners: () => deviceListeners.size,
    replaceDevices(next: DeviceSnapshot) { snapshot = next; for (const listener of [...deviceListeners]) listener(snapshot); },
    replaceOperations(next: readonly Operation[]) { catalogue = next; for (const listener of [...operationListeners]) listener(catalogue); },
    close() { controller.abort(); operations.dispose(); },
  };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(check(), '期望的本地任务状态未出现');
}

test('能力规则核对完整引用和实际声明，原始输入只接受有效JSON对象', async () => {
  const f = await fixture();
  try {
    const raw = { provider, capability: read, reference, input: {} };
    const list = f.operations.snapshot().result?.data ?? [];
    assert.equal(deviceActionReason(f.devices.snapshot(), list, raw), null);
    assert.match(deviceActionReason(f.devices.snapshot(), list, { ...raw, reference: { ...reference, generation: 'old' } }) ?? '', /已变化/);
    assert.match(deviceActionReason(f.devices.snapshot(), list, { ...raw, capability: { ...read, operation: 'forged' } }) ?? '', /声明已变化/);
    assert.match(deviceActionReason(f.devices.snapshot(), [], raw) ?? '', /服务器目录/);
    for (const value of ['[]', 'null', '{broken', '{"n":1e999}']) assert.throws(() => parseDeviceInput(value), /JSON/);
    assert.deepEqual(parseDeviceInput('{"argument":"保留"}'), { argument: '保留' });
  } finally { f.close(); }
});

test('连接动作接纳不冒充完成，沿公开设备与原Job管线读取终态并保留日志', async () => {
  const f = await fixture();
  const result = deferred<HostResult<Job>>();
  f.implementation.getJob = async () => result.promise;
  const action = createDeviceAction(f.context, f.operations, { pollIntervalMs: 0 });
  try {
    const waiting = action.run(request);
    await until(() => f.calls.get === 1);
    assert.equal(action.snapshot().phase, 'waiting');
    assert.equal(action.snapshot().ticket?.submitLogId, 'submit-log');
    assert.deepEqual(f.calls.invoke[0], { providerId: provider.id, generation: provider.generation,
      deviceId: null, capability: connect.id, version: 1, input: { address: 'test:1234' } });
    result.resolve({ data: job(), logId: 'final-log' });
    await waiting;
    assert.equal(action.snapshot().phase, 'succeeded');
    assert.equal(action.snapshot().logId, 'final-log');
    assert.deepEqual(action.snapshot().result, job().result);
  } finally { action.dispose(); f.close(); }
});

test('停止等待保留未知任务，只读查询不取消服务器或重放写入，晚到结果不污染', async () => {
  const f = await fixture(), late = deferred<HostResult<Job>>();
  f.implementation.getJob = async () => late.promise;
  const action = createDeviceAction(f.context, f.operations, { pollIntervalMs: 0 });
  try {
    const waiting = action.run(request);
    await until(() => f.calls.get === 1);
    action.cancel(); await waiting;
    assert.equal(action.snapshot().phase, 'unknown');
    assert.equal(action.snapshot().pending, false);
    assert.equal(action.snapshot().ticket?.id, 'test-job');
    f.implementation.getJob = async () => ({ data: job(), logId: 'query-log' });
    await action.query();
    assert.equal(action.snapshot().phase, 'succeeded');
    late.resolve({ data: { ...job(), result: '旧结果' }, logId: 'late-log' });
    await Promise.resolve();
    assert.equal(action.snapshot().logId, 'query-log');
    assert.equal(f.calls.invoke.length, 1); assert.equal(f.calls.cancel, 0);
  } finally { action.dispose(); f.close(); }
});

test('能力输入模式换代撤销旧等待，不封锁显式新操作且新成功不覆盖历史票据', async () => {
  const f = await fixture(), late = deferred<HostResult<Job>>();
  const original = f.operations.snapshot().result?.data ?? [];
  f.implementation.getJob = async () => late.promise;
  const action = createDeviceAction(f.context, f.operations, { pollIntervalMs: 0 });
  try {
    const waiting = action.run(request);
    await until(() => f.calls.get === 1);
    f.replaceOperations(original.map((entry) => ({ ...entry, input_schema: { type: 'object', changed: true } })));
    await waiting;
    assert.equal(action.snapshot().phase, 'unknown');
    f.replaceOperations(original);
    f.implementation.invoke = async () => ({ data: { ...job(), id: 'new-job' }, logId: 'new-log' });
    await action.run(request);
    assert.equal(action.snapshot().phase, 'succeeded');
    assert.equal(action.snapshot().ticket?.id, 'new-job');
    assert.equal(action.snapshot().previous[0]?.id, 'test-job');
    late.resolve({ data: job(), logId: 'late-log' });
    await Promise.resolve();
    assert.equal(action.snapshot().logId, 'new-log'); assert.equal(f.calls.invoke.length, 2);
  } finally { action.dispose(); f.close(); }
});

test('相同localId的目标代次变化撤销原始能力等待，不自动改选或跟随新目标', async () => {
  const f = await fixture(), late = deferred<HostResult<Job>>();
  f.implementation.getJob = async () => late.promise;
  const action = createDeviceAction(f.context, f.operations, { pollIntervalMs: 0 });
  try {
    const waiting = action.run({ provider, capability: read, reference, input: {} });
    await until(() => f.calls.get === 1);
    const current = f.devices.snapshot(), changed = { ...reference, generation: 'other-generation' };
    assert.ok(current.selected);
    f.replaceDevices({ ...current, selection: changed, selected: { ...current.selected, reference: changed } });
    await waiting;
    assert.equal(action.snapshot().phase, 'unknown');
    late.resolve({ data: job(read.operation), logId: 'wrong-generation-log' });
    await Promise.resolve();
    assert.notEqual(action.snapshot().phase, 'succeeded'); assert.equal(f.calls.invoke.length, 1);
    assert.deepEqual(f.calls.invoke[0]?.deviceId, reference.localId);
    assert.equal(f.calls.invoke[0]?.generation, reference.generation);
  } finally { action.dispose(); f.close(); }
});

test('提交忽略取消仍有界结束且不伪造任务ID，未知旧提交不阻断显式新调用', async () => {
  const f = await fixture(), late = deferred<HostResult<Job>>();
  f.implementation.invoke = async () => late.promise;
  const action = createDeviceAction(f.context, f.operations, { pollIntervalMs: 0, timeoutMs: 20 });
  try {
    const started = performance.now();
    await action.run(request);
    assert.ok(performance.now() - started < 2000);
    assert.equal(action.snapshot().phase, 'unknown'); assert.equal(action.snapshot().ticket, null);
    await action.query(); assert.equal(f.calls.get, 0);
    assert.match(action.snapshot().message ?? '', /尚未取得任务ID/);
    f.implementation.invoke = async () => ({ data: { ...job(), id: 'explicit-new' }, logId: 'explicit-log' });
    await action.run(request);
    late.resolve({ data: job(), logId: 'late-log' }); await Promise.resolve();
    assert.equal(action.snapshot().ticket?.id, 'explicit-new'); assert.equal(action.snapshot().logId, 'explicit-log');
    assert.equal(f.calls.invoke.length, 2); assert.equal(f.calls.cancel, 0);
  } finally { action.dispose(); f.close(); }
});

test('查询严格匹配已知任务身份，运行中只读一次，关闭后不留下可继续的调用', async () => {
  const f = await fixture(), late = deferred<HostResult<Job>>();
  f.implementation.getJob = async () => late.promise;
  const action = createDeviceAction(f.context, f.operations, { pollIntervalMs: 0 });
  try {
    const waiting = action.run(request);
    await until(() => f.calls.get === 1);
    action.cancel(); await waiting;
    f.implementation.getJob = async () => ({ data: { ...job(), id: 'another-job' }, logId: 'invalid-query-log' });
    await action.query(); assert.equal(action.snapshot().phase, 'unknown');
    assert.match(action.snapshot().message ?? '', /身份/);
    f.implementation.getJob = async () => ({ data: job(connect.operation, 'running'), logId: 'running-log' });
    await action.query();
    assert.equal(action.snapshot().phase, 'unknown');
    assert.equal(f.calls.get, 3); assert.equal(f.calls.invoke.length, 1);
    action.dispose();
    await assert.rejects(action.query(), /已关闭/);
    await assert.rejects(action.run(request), /已关闭/);
    late.resolve({ data: job(), logId: 'closed-log' });
  } finally { action.dispose(); f.close(); }
});

test('连接提交回执身份不匹配不保留假票据，不拿另一任务进行查询', async () => {
  const f = await fixture();
  f.implementation.invoke = async () => ({ data: job('another-operation'), logId: 'mismatch-log' });
  const action = createDeviceAction(f.context, f.operations);
  try {
    await action.run(request);
    assert.equal(action.snapshot().phase, 'unknown'); assert.equal(action.snapshot().ticket, null);
    assert.equal(action.snapshot().job, null); assert.equal(action.snapshot().logId, 'mismatch-log');
    await action.query(); assert.equal(f.calls.get, 0); assert.equal(f.calls.invoke.length, 1);
  } finally { action.dispose(); f.close(); }
});

test('连接后重新发现单独保留错误日志，提供者代次已撤销则不再发起发现', async () => {
  const f = await fixture();
  try {
    f.implementation.discover = async () => { throw Object.assign(new Error('目录独立失败'), { logId: 'discovery-failed' }); };
    const result = await discoverAfterConnection(f.context, provider);
    assert.equal(result.outcome, 'failed'); assert.equal(result.logId, 'discovery-failed');
    assert.match(result.message, /目录独立失败/); assert.equal(f.calls.invoke.length, 0);
    const current = f.devices.snapshot(); f.replaceDevices({ ...current, providers: [] });
    const absent = await discoverAfterConnection(f.context, provider);
    assert.match(absent.message, /代次已变化/); assert.equal(f.calls.discover, 1); assert.equal(f.listeners(), 0);
  } finally { f.close(); }
});

test('重新发现忽略取消仍可退出，释放订阅并拒绝晚到目录且不重放设备动作', async () => {
  const f = await fixture(), late = deferred<HostResult<DeviceDirectory>>();
  const caller = new AbortController(), signals: AbortSignal[] = [];
  f.implementation.discover = (signal) => { signals.push(signal); return late.promise; };
  try {
    const waiting = discoverAfterConnection(f.context, provider, caller.signal);
    assert.equal(f.calls.discover, 1);
    caller.abort();
    const result = await waiting;
    assert.equal(result.outcome, 'failed'); assert.match(result.message, /观测尚未确认/);
    assert.equal(signals[0]?.aborted, true); assert.equal(f.listeners(), 0);
    late.resolve({ data: { provider, observedAt: 2, discoveryJobId: 'late', devices: [] }, logId: 'late-directory' });
    await Promise.resolve();
    assert.equal(result.logId, null); assert.equal(f.calls.invoke.length, 0); assert.equal(f.calls.cancel, 0);
  } finally { f.close(); }
});
