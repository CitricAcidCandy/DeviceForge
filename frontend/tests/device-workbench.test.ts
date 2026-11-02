import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from 'tailwindcss';
import type { DeviceRef, DeviceSnapshot, Dispose, HostContext, UiAccess, WorkspaceLayout } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import createDevicesPlugin, {
  DEFAULT_DEVICE_LAYOUT, DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW, DEVICE_DIRECTORY_INSTANCE_ID,
  DEVICE_DIRECTORY_VIEW_ID, DEVICE_SCREEN_INSTANCE_ID, DEVICE_SCREEN_VIEW,
  DEVICE_WORKBENCH_INSTANCE_ID, DEVICE_WORKBENCH_VIEW_ID, DEVICES_PLUGIN_ID, DEVICES_WORKSPACE_ID, deviceTarget,
  screenApplicationsInstance, screenWorkbenchTarget, targetReference, updateDeviceReference,
} from '../plugins/devices/src/index.ts';
import { createWorkbenchChildren } from '../plugins/devices/src/workbench-children.ts';

const first: DeviceRef = { providerId: 'provider', generation: 'one', localId: 'same' };
const next: DeviceRef = { providerId: 'provider', generation: 'two', localId: 'same' };
const oldLayout: WorkspaceLayout = {
  version: 1, root: { kind: 'split', direction: 'horizontal', weights: [0.7, 0.3], children: [
    { kind: 'view', instanceId: DEVICE_SCREEN_INSTANCE_ID },
    { kind: 'tabs', active: 'apps', items: [
      { id: 'apps', node: { kind: 'view', instanceId: DEVICE_APPS_INSTANCE_ID } },
      { id: 'directory', node: { kind: 'view', instanceId: DEVICE_DIRECTORY_INSTANCE_ID } },
    ] },
  ] }, floating: [], overlays: [],
};
function fixture() {
  const registry = createWorkspaceRegistry(), lifetime = new AbortController();
  const releases: Dispose[] = [], listeners = new Set<(snapshot: DeviceSnapshot) => void>();
  let snapshot: DeviceSnapshot = { providers: [], directories: [], selection: first, selected: null };
  const unavailable = async (): Promise<never> => { throw new Error('组合单元不得提交业务或挂载真实设备'); };
  for (const view of [DEVICE_SCREEN_VIEW, DEVICE_APPS_VIEW]) {
    registry.access({ pluginId: view.pluginId, generation: 1, signal: lifetime.signal }).register({
      views: [{ id: view.viewId, title: '组合测试提供者', mount: unavailable }],
    });
  }
  const ui: UiAccess = { ...registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: lifetime.signal }), mount: unavailable };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, ui, listOperations: unavailable, submit: unavailable,
    getJob: unavailable, cancelJob: unavailable, subscribeOperations: () => () => {},
    onDispose: (release) => { releases.push(release); return release; },
    devices: {
      snapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      select(reference) { snapshot = { ...snapshot, selection: reference }; for (const listener of [...listeners]) listener(snapshot); },
      refreshProviders: unavailable, refreshDirectories: unavailable, refreshProvider: unavailable, invoke: unavailable,
    },
  };
  function openOld() {
    for (const [id, provider] of [
      [DEVICE_SCREEN_INSTANCE_ID, DEVICE_SCREEN_VIEW], [DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW],
      [DEVICE_DIRECTORY_INSTANCE_ID, { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_DIRECTORY_VIEW_ID }],
    ] as const) ui.open({ instanceId: id, workspaceId: DEVICES_WORKSPACE_ID, provider, target: deviceTarget(first) });
    ui.writeLayout(DEVICES_WORKSPACE_ID, oldLayout);
  }
  return { registry, context, ui, openOld,
    async activate() {
      const plugin = createDevicesPlugin({ id: DEVICES_PLUGIN_ID, version: '0.1.0', apiVersion: 2 });
      assert.ok(plugin.activate); await plugin.activate(context);
    },
    async close() { lifetime.abort(); for (const release of releases.reverse()) await release(); registry.dispose(); },
  };
}

test('旧默认三视图精确迁成工作台根，原插件扩展浮窗保持且旧默认实例撤销', async () => {
  const f = fixture();
  try {
    f.openOld();
    const addon = f.registry.access({ pluginId: 'addon', generation: 1, signal: new AbortController().signal });
    addon.open({ instanceId: 'addon.panel', workspaceId: DEVICES_WORKSPACE_ID, provider: null, target: { draft: '保留' } });
    const floating = [{ instanceId: 'addon.panel', x: 10, y: 20, width: 300, height: 200, z: 1 }];
    f.ui.writeLayout(DEVICES_WORKSPACE_ID, { ...oldLayout, floating });
    await f.activate();
    assert.deepEqual(f.ui.readLayout(DEVICES_WORKSPACE_ID), { ...DEFAULT_DEVICE_LAYOUT, floating });
    assert.deepEqual(f.ui.snapshot().instances.find((entry) => entry.instanceId === 'addon.panel')?.target, { draft: '保留' });
    assert.equal(f.ui.snapshot().instances.some((entry) => entry.instanceId === DEVICE_SCREEN_INSTANCE_ID), false);
    assert.equal(f.ui.snapshot().instances.some((entry) => entry.instanceId === DEVICE_APPS_INSTANCE_ID), false);
    assert.equal(f.ui.snapshot().instances.some((entry) => entry.instanceId === DEVICE_DIRECTORY_INSTANCE_ID), false);
  } finally { await f.close(); }
});

test('明确自选提供者、关闭默认视图或插件自定义布局不被默认迁移覆盖', async () => {
  for (const mode of ['provider', 'closed', 'custom'] as const) {
    const f = fixture();
    try {
      f.openOld();
      if (mode === 'provider') f.ui.selectProvider(DEVICE_APPS_INSTANCE_ID, { pluginId: 'alternative', viewId: 'alternative.apps' });
      if (mode === 'closed') f.ui.writeLayout(DEVICES_WORKSPACE_ID, { ...oldLayout, root: { kind: 'view', instanceId: DEVICE_SCREEN_INSTANCE_ID } });
      if (mode === 'custom') f.ui.writeLayout(DEVICES_WORKSPACE_ID, { ...oldLayout, root: {
        kind: 'custom', provider: { pluginId: 'alternative', viewId: 'alternative.layout' }, data: {},
        children: oldLayout.root ? [oldLayout.root] : [],
      } });
      const before = f.ui.readLayout(DEVICES_WORKSPACE_ID);
      await f.activate();
      assert.deepEqual(f.ui.readLayout(DEVICES_WORKSPACE_ID), before);
      assert.equal(f.ui.snapshot().instances.some((entry) => entry.instanceId === DEVICE_WORKBENCH_INSTANCE_ID), false);
    } finally { await f.close(); }
  }
});

test('工作台父视图拥有子实例可见性，切换设备撤销旧子项且保留组合元数据', async () => {
  const f = fixture();
  try {
    await f.activate();
    const parent = f.registry.resolveView(DEVICE_WORKBENCH_INSTANCE_ID);
    assert.ok(parent);
    const children = createWorkbenchChildren(f.context, parent.instance);
    const screen = () => f.ui.snapshot().instances.find((entry) => entry.instanceId === DEVICE_SCREEN_INSTANCE_ID);
    assert.equal(screenApplicationsInstance(screen()?.target ?? null), DEVICE_APPS_INSTANCE_ID);
    f.ui.setVisible(DEVICE_WORKBENCH_INSTANCE_ID, true);
    assert.equal(screen()?.visible, true);
    children.setDirectoryVisible(true);
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === DEVICE_DIRECTORY_INSTANCE_ID)?.visible, true);
    f.ui.setVisible(DEVICE_WORKBENCH_INSTANCE_ID, false);
    assert.ok(f.ui.snapshot().instances.filter((entry) => entry.instanceId !== DEVICE_WORKBENCH_INSTANCE_ID).every((entry) => !entry.visible));
    f.context.devices?.select(next);
    assert.equal(parent.instance.signal.aborted, true);
    assert.equal(screen()?.reason, 'owner_inactive');
    const current = f.registry.resolveView(DEVICE_WORKBENCH_INSTANCE_ID);
    assert.ok(current);
    const replacement = createWorkbenchChildren(f.context, current.instance);
    assert.deepEqual(targetReference(screen()?.target ?? null), next);
    assert.equal(screenApplicationsInstance(screen()?.target ?? null), DEVICE_APPS_INSTANCE_ID);
    assert.equal(f.ui.snapshot().instances.length, 4);
    children.dispose(); replacement.dispose();
    assert.equal(screen()?.reason, null);
    const changed = updateDeviceReference(screenWorkbenchTarget(first), next);
    assert.equal(screenApplicationsInstance(changed), DEVICE_APPS_INSTANCE_ID);
    assert.deepEqual(targetReference(changed), next);
  } finally { await f.close(); }
});

test('设备组合层Tailwind规则生成实际容器查询，不退回浏览器媒体断点', async () => {
  const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
  const css = compiler.build([
    '@container/device-screen', '@container/device',
    '@max-[1024px]/device-screen:grid-cols-[minmax(0,1fr)]',
    '@max-[1180px]/device-screen:grid-cols-[minmax(0,1fr)_312px]',
    '@max-[1024px]/device-screen:row-start-2',
    '@max-[1024px]/device:top-3',
  ]);
  assert.match(css, /container-name: device-screen/);
  assert.match(css, /@container device-screen \(width < 1024px\)/);
  assert.match(css, /@container device-screen \(width < 1180px\)/);
  assert.match(css, /@container device \(width < 1024px\)/);
  assert.doesNotMatch(css, /@media/);
});

test('额外工作台使用独立子实例，不关闭主工作台或争用旧应用槽位', async () => {
  const f = fixture();
  try {
    await f.activate();
    const main = f.registry.resolveView(DEVICE_WORKBENCH_INSTANCE_ID);
    assert.ok(main);
    const primary = createWorkbenchChildren(f.context, main.instance);
    const screen = f.registry.resolveView(primary.screenInstanceId);
    assert.ok(screen);
    const id = 'deviceforge_devices.workbench.extra';
    f.ui.open({ instanceId: id, workspaceId: DEVICES_WORKSPACE_ID,
      provider: { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_WORKBENCH_VIEW_ID }, target: deviceTarget(first) });
    const secondary = f.registry.resolveView(id);
    assert.ok(secondary);
    const extra = createWorkbenchChildren(f.context, secondary.instance);
    assert.notEqual(extra.screenInstanceId, primary.screenInstanceId);
    assert.notEqual(extra.applicationsInstanceId, DEVICE_APPS_INSTANCE_ID);
    assert.notEqual(extra.directoryInstanceId, primary.directoryInstanceId);
    assert.equal(screen.instance.signal.aborted, false);
    f.ui.close(id);
    assert.equal(screen.instance.signal.aborted, false);
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === primary.screenInstanceId)?.state, 'ready');
    f.ui.open({ instanceId: id, workspaceId: DEVICES_WORKSPACE_ID,
      provider: { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_WORKBENCH_VIEW_ID }, target: deviceTarget(first) });
    const restored = f.registry.resolveView(id);
    assert.ok(restored);
    const replacement = createWorkbenchChildren(f.context, restored.instance);
    assert.equal(replacement.screenInstanceId, extra.screenInstanceId, '撤销的自有嵌套编号可以重用，不不断积累占位');
    assert.notEqual(replacement.owned()[0]?.generation, extra.owned()[0]?.generation);
    primary.dispose(); extra.dispose(); replacement.dispose();
  } finally { await f.close(); }
});

test('主工作台换代保留显式提供者、空选择和插件自有目标，不强行覆盖扩展', async () => {
  const f = fixture();
  try {
    await f.activate();
    const original = f.registry.resolveView(DEVICE_WORKBENCH_INSTANCE_ID);
    assert.ok(original);
    const children = createWorkbenchChildren(f.context, original.instance);
    const provider = { pluginId: 'alternative', viewId: 'alternative.apps' };
    f.ui.selectProvider(children.applicationsInstanceId, provider);
    f.ui.setTarget(children.applicationsInstanceId, { documentId: '插件草稿目标' });
    f.ui.selectProvider(children.directoryInstanceId, null);
    f.context.devices?.select(next);
    const current = f.registry.resolveView(DEVICE_WORKBENCH_INSTANCE_ID);
    assert.ok(current);
    const replacement = createWorkbenchChildren(f.context, current.instance);
    const apps = f.ui.snapshot().instances.find((entry) => entry.instanceId === replacement.applicationsInstanceId);
    assert.deepEqual(apps?.provider, provider);
    assert.deepEqual(apps?.target, { documentId: '插件草稿目标' });
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === replacement.directoryInstanceId)?.provider, null);
    children.dispose(); replacement.dispose();
  } finally { await f.close(); }
});
