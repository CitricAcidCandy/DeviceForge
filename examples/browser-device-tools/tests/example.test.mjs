import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import plugin, { activateExample } from '../src/index.mjs';
import { gate, historicalJob, operation, provider, publicHost } from './public-host.mjs';

const readAction = (owner, generation) => ({ providerId: owner, generation, deviceId: 'same-local-id',
  capability: 'echo', version: 1, input: { value: '示例业务参数' } });

test('在线包清单、版本和独立 ESM 入口一致', async () => {
  const descriptor = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
  assert.equal(descriptor.type, 'module'); assert.equal(descriptor.deviceforge.kind, 'browser');
  assert.deepEqual(descriptor.deviceforge.entrypoints.any, { runtime: 'browser', path: 'src/index.mjs' });
  assert.equal(manifest.id, plugin.id); assert.equal(manifest.version, plugin.version);
  assert.equal(descriptor.version, plugin.version); assert.equal(manifest.api_version, plugin.apiVersion);
  assert.deepEqual(plugin.panels, []);
  await readFile(new URL('../' + descriptor.deviceforge.entrypoints.any.path, import.meta.url));
});

test('公开配置实际控制任务保留数量与目录事件，后续调用读取新值', async () => {
  const host = publicHost();
  let values = { rememberedJobs: 1, publishEvents: false };
  const session = await activateExample({ ...host.context, configuration: { get: () => ({ ...values }), subscribe: () => () => {} } }, 'test-configuration');
  try {
    assert.equal(plugin.configuration.apply_policy, 'next_invocation');
    session.remember({ id: 'first' }, host.context.signal);
    session.remember({ id: 'second' }, host.context.signal);
    assert.deepEqual(session.snapshot().acceptedJobIds, ['second']);
    assert.equal(host.events.length, 0);
    values = { rememberedJobs: 2, publishEvents: true };
    session.remember({ id: 'third' }, host.context.signal);
    assert.deepEqual(session.snapshot().acceptedJobIds, ['second', 'third']);
    assert.equal(host.events.at(-1).name, plugin.id + '.changed');
  } finally { await host.dispose(); }
});

test('可选 devices 缺省时普通任务和历史仍可消费，设备命令明确失败', async () => {
  const host = publicHost({ hasDevices: false });
  await activateExample(host.context, 'test-no-devices');
  try {
    const catalog = await host.command('catalog')({});
    assert.equal(catalog.data.devices, null);
    const submitted = await host.command('submit')({ operation: operation.id, input: { unchanged: true } });
    assert.equal(submitted.data.id, 'job-submitted');
    assert.deepEqual(host.calls.submit, [{ operation: operation.id, input: { unchanged: true } }]);
    assert.deepEqual((await host.service('history-service')({ jobId: historicalJob.id })).data, historicalJob);
    await assert.rejects(host.command('refresh-devices')({}), { code: 'example_devices_unsupported' });
  } finally { await host.dispose(); }
});

test('同名设备按完整提供者引用调用，精确版本和只读限制在调用前拒绝', async () => {
  const host = publicHost(); host.providers([provider('first', 'g1'), provider('second', 'g2')]);
  await activateExample(host.context, 'test-two-providers');
  try {
    await host.command('select')({ providerId: 'second', generation: 'g2', localId: 'same-local-id' });
    await host.command('invoke-read')(readAction('second', 'g2'));
    assert.equal(host.calls.invoke.length, 1); assert.equal(host.calls.invoke[0].action.providerId, 'second');
    await assert.rejects(host.command('invoke-read')({ ...readAction('second', 'g2'), version: 2 }),
      { code: 'example_capability_unavailable' });
    await assert.rejects(host.command('invoke-read')({ ...readAction('second', 'g2'), capability: 'write' }),
      { code: 'example_read_only' });
    await assert.rejects(host.command('invoke-read')({ ...readAction('second', 'g2'), timeoutMs: 99999 }),
      { code: 'example_input' });
    assert.equal(host.calls.invoke.length, 1);
    assert.equal(Object.hasOwn(host.calls.invoke[0].action, 'executionTimeoutMs'), false);
  } finally { await host.dispose(); }
});

test('提供者换代取消在途调用，即使忽略信号晚到也不登记旧 Job，新调用必须显式新代', async () => {
  const host = publicHost(); host.providers([provider('owner', 'g1')]);
  const session = await activateExample(host.context, 'test-reload');
  const delayed = gate(); host.behavior.invoke = () => delayed.promise;
  try {
    const pending = host.command('invoke-read')(readAction('owner', 'g1'));
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    assert.equal(host.calls.invoke.length, 1);
    host.providers([provider('owner', 'g2')]);
    assert.equal(host.calls.invoke[0].signal.aborted, true);
    delayed.resolve({ data: { ...historicalJob, id: 'late-old-job' }, logId: 'fake-old-response' });
    await rejected;
    assert.deepEqual(session.snapshot().acceptedJobIds, []);
    await assert.rejects(host.command('invoke-read')(readAction('owner', 'g1')), { code: 'example_capability_unavailable' });
    delete host.behavior.invoke;
    await host.command('invoke-read')(readAction('owner', 'g2'));
    assert.deepEqual(session.snapshot().acceptedJobIds, ['job-device']);
  } finally { await host.dispose(); }
});

test('历史服务不依赖已撤销目录，不补当前预算、设备引用或原文', async () => {
  const host = publicHost(); host.providers([provider('owner', 'g1')]);
  await activateExample(host.context, 'test-history');
  try {
    const before = await host.service('history-service')({ jobId: historicalJob.id });
    host.providers([]); host.operations([]);
    const after = await host.service('history-service')({ jobId: historicalJob.id });
    assert.deepEqual(before, after); assert.deepEqual(after.data, historicalJob);
    assert.deepEqual(Object.keys(after.data).sort(), ['error', 'id', 'operation', 'result', 'status']);
    assert.deepEqual(host.calls.getJob, [historicalJob.id, historicalJob.id]);
  } finally { await host.dispose(); }
});

test('钩子真正停止撤销操作的提交，解除登记后宿主流程恢复', async () => {
  const host = publicHost(); const session = await activateExample(host.context, 'test-hook');
  host.operations([]);
  await assert.rejects(host.context.submit(operation.id, { original: true }, host.context.signal),
    { code: 'example_operation_unavailable' });
  assert.equal(host.calls.submit.length, 0);
  await session.close();
  await host.context.submit(operation.id, { original: true }, host.context.signal);
  assert.deepEqual(host.calls.submit, [{ operation: operation.id, input: { original: true } }]);
  await host.dispose();
});

test('目录查询晚到不覆盖新通知，实例退出释放所有登记并拒绝旧服务引用', async () => {
  const host = publicHost(); await activateExample(host.context, 'test-dispose');
  const oldService = host.service('catalog-service');
  const delayed = gate(); host.behavior.listOperations = () => delayed.promise;
  const pending = oldService({});
  host.operations([]);
  delayed.resolve({ data: [operation], logId: 'fake-late-list' });
  assert.deepEqual((await pending).data.operations, []);
  delete host.behavior.listOperations;
  await host.dispose();
  assert.deepEqual(host.listeners(), { operations: 0, devices: 0, registrations: 0 });
  const priorCalls = host.calls.listOperations;
  await assert.rejects(oldService({}), { name: 'AbortError' });
  assert.equal(host.calls.listOperations, priorCalls);
});

test('普通 LAN HTTP 没有 crypto.randomUUID 时也能激活，标记只区分本地生命周期', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const first = publicHost(); const second = publicHost();
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    const before = await activateExample(first.context);
    const after = await activateExample(second.context);
    assert.equal(typeof before.snapshot().runId, 'string');
    assert.ok(before.snapshot().runId.length > 0);
    assert.notEqual(before.snapshot().runId, after.snapshot().runId);
    assert.equal(first.listeners().registrations, 1);
    assert.equal(second.listeners().registrations, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else Reflect.deleteProperty(globalThis, 'crypto');
    await first.dispose(); await second.dispose();
  }
});

test('提供者等待完成后立即换代，Job 接受已在完成前同步提交，撤销后不再登记旧响应', async () => {
  const host = publicHost(); host.providers([provider('owner', 'g1')]);
  const session = await activateExample(host.context, 'test-acceptance-boundary');
  const original = session.withProvider;
  let acceptedBeforeRevocation;
  // 确定性地在原 withProvider 对外完成与调用者下一续执行之间换代，复现旧窗口。
  session.withProvider = (...args) => original(...args).then((reply) => {
    acceptedBeforeRevocation = session.snapshot().acceptedJobIds;
    host.providers([provider('owner', 'g2')]);
    return reply;
  });
  try {
    const reply = await host.command('invoke-read')(readAction('owner', 'g1'));
    assert.equal(reply.data.id, 'job-device');
    assert.deepEqual(acceptedBeforeRevocation, ['job-device']);
    assert.deepEqual(session.snapshot().acceptedJobIds, acceptedBeforeRevocation);
    assert.equal(session.snapshot().devices.providers[0].generation, 'g2');
    await assert.rejects(host.command('invoke-read')(readAction('owner', 'g1')),
      { code: 'example_capability_unavailable' });
    assert.equal(host.calls.invoke.length, 1);
  } finally { session.withProvider = original; await host.dispose(); }
});

test('公开目录完整透传普通及设备预算和原始状态，命令服务与发布观测一致', async () => {
  const host = publicHost();
  const declared = { ...operation, id: 'plugin.mock.declared',
    execution: { apiVersion: 1, totalTimeoutMs: 120000, source: 'declared' } };
  const legacy = { id: 'plugin.mock.legacy', title: '模拟旧目录', input_schema: { type: 'object' } };
  const owner = provider('metadata', 'g1');
  owner.definition.capabilities[0].executionTimeoutMs = 120000;
  host.operations([operation, declared, legacy]); host.providers([owner]);
  // 激活前配置现有 mock 返回的公开值；SDK 的 None 形态是字段省略，不是 null。
  const observed = host.context.devices.snapshot();
  const rawState = '  Recovery_未知🧪  ';
  observed.directories[0].devices[0].state = 'unknown';
  observed.directories[0].devices[0].rawState = rawState;
  try {
    await activateExample(host.context, 'test-public-metadata');
    const catalog = await host.command('catalog')({});
    const service = await host.service('catalog-service')({});
    for (const reply of [catalog, service]) {
      assert.equal(reply.logId, 'fake-operations');
      assert.deepEqual(reply.data.operations, [operation, declared, legacy]);
      assert.deepEqual(reply.data.devices, observed);
      assert.deepEqual(reply.data.operations[0].execution,
        { apiVersion: 1, totalTimeoutMs: 60000, source: 'default' });
      assert.deepEqual(reply.data.operations[1].execution,
        { apiVersion: 1, totalTimeoutMs: 120000, source: 'declared' });
      assert.equal(Object.hasOwn(reply.data.operations[2], 'execution'), false);
      assert.equal(reply.data.devices.providers[0].definition.capabilities[0].executionTimeoutMs, 120000);
      assert.equal(Object.hasOwn(reply.data.devices.providers[0].definition.capabilities[1], 'executionTimeoutMs'), false);
      assert.equal(reply.data.devices.directories[0].devices[0].rawState, rawState);
      assert.equal(reply.data.devices.directories[0].devices[0].state, 'unknown');
    }
    assert.deepEqual(host.state.get('browser_device_tools.catalog'), service.data);
    assert.equal(host.events.at(-1)?.name, 'browser_device_tools.changed');
    assert.deepEqual(host.events.at(-1)?.data, service.data);
  } finally { await host.dispose(); }
});

test('同代后续 None 观测替换旧原文和预算，旧快照独立且历史任务不补当前元数据', async () => {
  const host = publicHost();
  const expectedHistory = { data: structuredClone(historicalJob), logId: 'fake-history' };
  const declared = { ...operation,
    execution: { apiVersion: 1, totalTimeoutMs: 10000, source: 'declared' } };
  const owner = provider('replacement', 'g1');
  owner.definition.capabilities[0].executionTimeoutMs = 120000;
  host.operations([declared]); host.providers([owner]);
  // 只配置既有 mock 的初始返回值；后续通过其已有通知入口发布整份新观测。
  host.context.devices.snapshot().directories[0].devices[0].rawState = 'device_原文';
  try {
    await activateExample(host.context, 'test-none-replacement');
    const selected = { providerId: owner.id, generation: owner.generation, localId: 'same-local-id' };
    await host.command('select')(selected);
    const before = await host.service('catalog-service')({});
    const historyBefore = await host.service('history-service')({ jobId: historicalJob.id });
    assert.deepEqual(historyBefore, expectedHistory);
    assert.equal(before.data.devices.selected.rawState, 'device_原文');
    assert.deepEqual(before.data.operations[0].execution, declared.execution);

    const withoutExecution = { id: operation.id, title: operation.title, input_schema: operation.input_schema };
    host.operations([withoutExecution]); host.providers([provider(owner.id, owner.generation)]);
    await host.command('select')(selected);
    const after = await host.command('catalog')({});
    assert.deepEqual(after.data.operations, [withoutExecution]);
    assert.deepEqual(after.data.devices, host.context.devices.snapshot());
    assert.equal(after.data.devices.providers[0].generation, owner.generation);
    assert.equal(Object.hasOwn(after.data.operations[0], 'execution'), false);
    assert.equal(Object.hasOwn(after.data.devices.providers[0].definition.capabilities[0], 'executionTimeoutMs'), false);
    assert.equal(Object.hasOwn(after.data.devices.directories[0].provider.definition.capabilities[0], 'executionTimeoutMs'), false);
    assert.equal(Object.hasOwn(after.data.devices.directories[0].devices[0], 'rawState'), false);
    assert.equal(Object.hasOwn(after.data.devices.selected, 'rawState'), false);
    assert.deepEqual(host.state.get('browser_device_tools.catalog'), after.data);
    assert.deepEqual(host.events.at(-1)?.data, after.data);
    assert.ok(after.data.revisions.operations > before.data.revisions.operations);
    assert.ok(after.data.revisions.devices > before.data.revisions.devices);
    assert.equal(before.data.devices.selected.rawState, 'device_原文');
    assert.equal(before.data.devices.directories[0].devices[0].rawState, 'device_原文');
    assert.equal(before.data.devices.providers[0].definition.capabilities[0].executionTimeoutMs, 120000);
    assert.deepEqual(before.data.operations[0].execution, declared.execution);

    const historyAfter = await host.service('history-service')({ jobId: historicalJob.id });
    assert.deepEqual(historyBefore, historyAfter);
    assert.deepEqual(historyAfter, expectedHistory);
    assert.deepEqual(Object.keys(historyAfter.data).sort(), ['error', 'id', 'operation', 'result', 'status']);
    assert.deepEqual(host.calls.getJob, [historicalJob.id, historicalJob.id]);
  } finally { await host.dispose(); }
});
