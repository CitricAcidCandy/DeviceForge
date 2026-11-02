import test from 'node:test';
import assert from 'node:assert/strict';
import createDeviceAppsPlugin from '../plugins/device-apps/src/index.ts';
import { createDeviceAppsInstances } from '../plugins/device-apps/src/instances.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { deviceTarget } from '@deviceforge/devices/model';
import { capabilityGate, decodeAppList, deviceAction, executeDeviceTask } from '@deviceforge/business-kit/device';
import type { HostContext, HostResult, Job } from '../src/plugin-sdk/index.ts';
import { reference, operation, fixture, deviceState, completed } from './device-apps-plugin-fixtures.ts';
import { deferred } from './fixtures.ts';

function instanceFixture() {
  const f = fixture(), registry = createWorkspaceRegistry(), pluginId = 'apps_instances';
  const ui = registry.access({ pluginId, generation: 1, signal: f.context.signal });
  ui.register({
    workspaces: [{ id: `${pluginId}.workspace`, title: '设备应用' }],
    views: [{ id: `${pluginId}.main`, title: '应用', mount: async () => () => {} }],
  });
  const pool = createDeviceAppsInstances({ ...f.context, ui }, pluginId);
  const open = (id: string) => ui.open({
    instanceId: `${pluginId}.${id}`, workspaceId: `${pluginId}.workspace`,
    provider: { pluginId, viewId: `${pluginId}.main` }, target: deviceTarget(reference),
  });
  return {
    ...f, ui, pool, open,
    get counts() { return f.counts; },
    async dispose() { await f.dispose(); registry.dispose(); },
  };
}

test('真实manager激活只登记设备应用视图，不登记页面、默认实例或执行设备操作', async () => {
  const f = fixture(), id = 'deviceforge_device_apps';
  try {
    f.runtime.bundledPlugins.register({ id, trusted: true,
      plugin: createDeviceAppsPlugin({ id, version: '0.1.0', apiVersion: 2 }) });
    await f.runtime.webPlugins.load(id);
    const ui = f.runtime.host.ui;
    assert.ok(ui);
    assert.deepEqual(ui.catalog().views.filter((view) => view.pluginId === id)
      .map((view) => [view.id, view.provides]), [[`${id}.main`, ['device.apps']]]);
    assert.equal(ui.catalog().pages.filter((page) => page.pluginId === id).length, 0);
    assert.equal(ui.snapshot().instances.filter((instance) => instance.pluginId === id).length, 0);
    assert.equal(f.counts.invocations, 0);
    assert.equal(f.counts.uploads, 0);
    const point = { id: 'deviceforge_devices.task-operations', version: '1' };
    const contribution = f.runtime.host.extensions?.points?.list(point).find((entry) => entry.provider.pluginId === id);
    assert.equal(contribution?.state, 'waiting');
    assert.deepEqual(contribution?.data, { operations: [
      'manifest', 'signature', 'extract_apk', 'build_apks', 'decode', 'scan_sdks', 'extract_splits',
    ].map((action) => `plugin.android-packages.${action}`) });
    await f.runtime.webPlugins.unload(id);
    assert.equal(ui.catalog().views.some((view) => view.pluginId === id), false);
    assert.equal(f.runtime.host.extensions?.points?.list(point).some((entry) => entry.provider.pluginId === id), false);
  } finally { await f.dispose(); }
});

test('缺少公开产物能力时明确失败，不登记能够操作的半成品视图', async () => {
  const f = fixture();
  try {
    const { artifacts, ...remaining } = f.context;
    assert.ok(artifacts);
    const plugin = createDeviceAppsPlugin({ id: 'missing_apps', version: '1', apiVersion: 2 });
    assert.ok(plugin.activate);
    const context: HostContext = remaining;
    await assert.rejects(plugin.activate(context), /公开工作区、设备和产物能力/);
    assert.equal(f.runtime.host.ui?.catalog().views.some((view) => view.id === 'missing_apps.main'), false);
  } finally { await f.dispose(); }
});

test('隐藏和再次取得同一实例保留草稿，多实例独立，关闭只撤销对应订阅与请求资格', async () => {
  const f = instanceFixture();
  try {
    const first = f.open('one'), second = f.open('two');
    const one = f.pool.retain(first), two = f.pool.retain(second);
    one.drafts.apps.filter.value = 'com.example';
    one.drafts.packages.entry.value = 'splits/original.apk';
    f.ui.setVisible(first.instanceId, false);
    const hidden = f.ui.snapshot().instances.find((instance) => instance.instanceId === first.instanceId);
    assert.ok(hidden);
    assert.equal(f.pool.retain(hidden), one);
    assert.equal(one.drafts.apps.filter.value, 'com.example');
    assert.equal(two.drafts.apps.filter.value, '');
    assert.equal(two.drafts.packages.entry.value, '');
    f.ui.close(first.instanceId);
    assert.equal(one.context.signal.aborted, true);
    assert.equal(two.context.signal.aborted, false);
    assert.equal(two.matchesTarget(), true);
  } finally { await f.dispose(); }
});

test('目标代次变化撤销旧等待，旧成功不污染新模型，也不自动提交或重放', async () => {
  const f = instanceFixture(), pending = deferred<HostResult<Job>>();
  try {
    const initial = f.open('one'), previous = f.pool.retain(initial);
    previous.drafts.apps.filter.value = '旧草稿';
    f.setInvoke(async () => pending.promise);
    const gate = capabilityGate(previous.devices.snapshot(), [operation], 'packages');
    const waiting = executeDeviceTask(previous, 'packages', deviceAction(reference, gate, {}),
      new AbortController().signal, decodeAppList);
    const nextReference = { ...reference, generation: 'generation-b' };
    const next = f.ui.setTarget(initial.instanceId, deviceTarget(nextReference));
    await assert.rejects(waiting);
    const current = f.pool.retain(next);
    assert.notEqual(current, previous);
    assert.equal(previous.context.signal.aborted, true);
    assert.equal(current.drafts.apps.filter.value, '');
    f.change(deviceState(nextReference));
    assert.equal(current.matchesTarget(), true);
    pending.resolve(completed());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.counts.invocations, 1);
    assert.equal(current.drafts.apps.list.value, null);
    assert.equal(current.drafts.apps.filter.value, '');
  } finally { pending.resolve(completed()); await f.dispose(); }
});

test('错误目标或提供者被拒绝，插件撤销后所有旧实例均失效', async () => {
  const f = instanceFixture();
  try {
    const instance = f.open('one');
    assert.throws(() => f.pool.retain({ ...instance, target: { kind: 'device', reference: { localId: 'a' } } }),
      /完整设备引用/);
    assert.throws(() => f.pool.retain({ ...instance,
      provider: { pluginId: 'other', viewId: 'other.main' } }), /提供者已撤销/);
    const services = f.pool.retain(instance);
    f.pool.dispose(); f.pool.dispose();
    assert.equal(services.context.signal.aborted, true);
    assert.equal(f.counts.listeners, 0);
    assert.throws(() => f.pool.retain(instance), /提供者已撤销/);
  } finally { await f.dispose(); }
});
