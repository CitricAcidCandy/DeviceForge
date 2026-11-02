import test from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceAction, HostResult, Job } from '../src/plugin-sdk/index.ts';
import { ApiError } from '@deviceforge/business-kit/api';
import { capabilityGate, decodeAppList, deviceAction, executeDeviceTask } from '@deviceforge/business-kit/device';
import { createDeviceAppsServices } from '../plugins/device-apps/src/services.ts';
import { deferred } from './fixtures.ts';
import { reference, operation, deviceState, completed, fixture } from './device-apps-plugin-fixtures.ts';

test('设备应用模型创建不刷新、不上传、不提交，完整设备引用与实例目标一致才开放能力', async () => {
  const f = fixture();
  try {
    const services = createDeviceAppsServices(f.context, reference);
    assert.equal(f.counts.invocations, 0);
    assert.equal(f.counts.uploads, 0);
    assert.equal(services.matchesTarget(), true);
    assert.ok(capabilityGate(services.devices.snapshot(), [operation], 'packages').capability);
    f.change(deviceState({ ...reference, generation: 'generation-b' }));
    assert.equal(services.matchesTarget(), false);
    assert.equal(services.devices.snapshot().selection, null);
    assert.equal(capabilityGate(services.devices.snapshot(), [operation], 'packages').capability, null);
    services.dispose();
  } finally { await f.dispose(); }
});

test('设备应用通过公开能力与Job解码真实标识，未知文本不变成可执行应用', async () => {
  const f = fixture();
  try {
    const services = createDeviceAppsServices(f.context, reference);
    const gate = capabilityGate(services.devices.snapshot(), [operation], 'packages');
    const result = await executeDeviceTask(services, 'packages', deviceAction(reference, gate, {}),
      new AbortController().signal, decodeAppList);
    assert.deepEqual(result.data.identifiers, ['com.example.app']);
    assert.equal(result.logId, 'apps-log');
    assert.equal(f.counts.invocations, 1);
    assert.deepEqual(decodeAppList({ result: { output: 'package:com.example.app\nwarning!' }, artifacts: [] },
      'raw-log').identifiers, []);
    services.dispose();
  } finally { await f.dispose(); }
});

test('切换目标立即撤销旧等待，忽略取消的晚到结果不能写入原实例或重放', async () => {
  const f = fixture(), pending = deferred<HostResult<Job>>();
  try {
    f.setInvoke(async () => pending.promise);
    const services = createDeviceAppsServices(f.context, reference);
    const gate = capabilityGate(services.devices.snapshot(), [operation], 'packages');
    const waiting = executeDeviceTask(services, 'packages', deviceAction(reference, gate, {}),
      new AbortController().signal, decodeAppList);
    f.change(deviceState({ ...reference, localId: 'device-b' }));
    await assert.rejects(waiting);
    pending.resolve(completed());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.counts.invocations, 1);
    f.change(deviceState());
    assert.equal(services.matchesTarget(), true);
    services.dispose();
  } finally { pending.resolve(completed()); await f.dispose(); }
});

test('绑定设备适配器拒绝伪造动作身份，不自动改选；无目标时不补选', async () => {
  const f = fixture();
  try {
    const services = createDeviceAppsServices(f.context, reference);
    const action: DeviceAction = { ...reference, deviceId: reference.localId,
      capability: 'packages', version: 1, input: {} };
    await assert.rejects(services.devices.invoke({ ...action, generation: 'generation-b' },
      new AbortController().signal), ApiError);
    assert.equal(f.counts.invocations, 0);
    const empty = createDeviceAppsServices(f.context, null);
    assert.equal(empty.matchesTarget(), false);
    assert.equal(empty.devices.snapshot().selection, null);
    empty.dispose(); services.dispose();
  } finally { await f.dispose(); }
});

test('实例销毁撤销上传与自有订阅，未知安装结果不自动重放或取消服务器Job', async () => {
  const f = fixture();
  try {
    const services = createDeviceAppsServices(f.context, reference);
    services.dispose(); services.dispose();
    await assert.rejects(services.artifacts.upload('app.apk', new Blob(['app']),
      new AbortController().signal));
    assert.equal(f.counts.uploads, 0);
    assert.equal(f.counts.listeners, 0);
  } finally { await f.dispose(); }
});

test('安装提交结果未知保留原日志，不自动重放，也不封锁之后的显式独立操作', async () => {
  const f = fixture();
  try {
    const installOperation = {
      id: 'plugin.device.install', title: '安装',
      input_schema: { properties: { input: { type: 'object',
        properties: { artifact_id: { type: 'string' } }, required: ['artifact_id'] } } },
    };
    const install = { id: 'app.install', version: 1, operation: installOperation.id,
      scope: 'device', access: 'write' } satisfies import('../src/plugin-sdk/index.ts').DeviceCapability;
    f.change(deviceState(reference, [install]));
    f.setOperations([installOperation]);
    f.setInvoke(async () => {
      throw new ApiError('network', 'install_unknown', '安装受理结果未知', null, 'install-original-log');
    });
    const services = createDeviceAppsServices(f.context, reference);
    const gate = capabilityGate(services.devices.snapshot(), [installOperation], 'app.install');
    const action = deviceAction(reference, gate, { artifact_id: 'original-artifact' });
    await assert.rejects(executeDeviceTask(services, 'app.install', action,
      new AbortController().signal, decodeAppList), (error) =>
      error instanceof ApiError && error.code === 'install_unknown' && error.logId === 'install-original-log');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.counts.invocations, 1);
    assert.ok(capabilityGate(services.devices.snapshot(), [installOperation], 'app.install').capability);
    services.dispose();
  } finally { await f.dispose(); }
});
