import assert from 'node:assert/strict';
import test from 'node:test';
import createDevicesPlugin, {
  DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW, DEVICE_DIRECTORY_INSTANCE_ID,
  DEVICE_SCREEN_INSTANCE_ID, DEVICE_SCREEN_VIEW, DEVICE_TARGET_EVENT, DEVICE_TARGET_SERVICE,
  DEVICE_TOOLS_POINT, DEVICES_PLUGIN_ID, DEVICES_WORKSPACE_ID,
  DEVICE_TASKS_POINT,
  LEGACY_DEVICE_APPS_VIEW, DEFAULT_DEVICE_LAYOUT, DEVICE_WORKBENCH_INSTANCE_ID, DEVICE_WORKBENCH_VIEW_ID,
} from '../plugins/devices/src/index.ts';
import {
  addDeviceTool, deviceTarget, references, sameDevice, targetReference,
} from '../plugins/devices/src/model.ts';
import { createDeviceDirectory } from '../plugins/devices/src/directory.ts';
import type {
  DeviceAccess, DeviceDirectory, DeviceProviderInfo, DeviceRef, DeviceSnapshot, Dispose,
  HostContext, HostResult, JsonValue, PluginContributions, PointAccess,
} from '../src/plugin-sdk/index.ts';
import { createPointRegistry } from '../src/plugins/points/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { deferred } from './fixtures.ts';

const first: DeviceRef = { providerId: 'custom_provider', generation: 'provider-generation-1', localId: 'same-id' };
const second: DeviceRef = { providerId: 'second_provider', generation: 'provider-generation-2', localId: 'same-id' };
const provider: DeviceProviderInfo = {
  id: first.providerId, generation: first.generation, version: '1.0.0',
  definition: { apiVersion: 3, platform: '自定义平台', discoverOperation: 'custom_provider.discover', capabilities: [] },
};
const directory: DeviceDirectory = {
  provider, observedAt: 1, discoveryJobId: 'read-only-test',
  devices: [{ reference: first, model: '自定义设备', state: 'online', capabilities: [] }],
};
function deviceFixture(initial: DeviceRef | null = first) {
  let state: DeviceSnapshot = { providers: [provider], directories: [directory], selected: directory.devices[0] ?? null, selection: initial };
  const listeners = new Set<(value: DeviceSnapshot) => void>();
  const calls: string[] = [];
  const notify = () => { for (const listener of [...listeners]) listener(state); };
  const devices: DeviceAccess = {
    snapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(reference) {
      state = {
        ...state, selection: reference,
        selected: state.directories.flatMap((entry) => entry.devices).find((entry) => sameDevice(entry.reference, reference)) ?? null,
      };
      notify();
    },
    refreshProviders: async () => { calls.push('providers'); return { data: state.providers, logId: 'provider-log' }; },
    refreshDirectories: async () => { calls.push('directories'); return { data: state.directories, logId: 'directory-log' }; },
    refreshProvider: async () => { calls.push('discover'); return { data: directory, logId: 'discovery-log' }; },
    invoke: async () => { calls.push('invoke'); throw new Error('测试不得发起设备执行'); },
  };
  return {
    devices, calls,
    count: () => listeners.size,
    replace(next: DeviceSnapshot) { state = next; notify(); },
  };
}
function fixture(extra: Partial<HostContext> = {}) {
  const controller = new AbortController();
  const releases: Dispose[] = [];
  const host: HostContext = {
    apiVersion: 2, signal: controller.signal,
    listOperations: async () => { throw new Error('激活不得读取操作'); },
    submit: async () => { throw new Error('激活不得提交业务'); },
    getJob: async () => { throw new Error('激活不得查询任务'); },
    cancelJob: async () => { throw new Error('激活不得取消任务'); },
    subscribeOperations: () => () => {},
    onDispose: (release) => { releases.push(release); return release; },
    ...extra,
  };
  return {
    host, controller,
    async dispose() {
      controller.abort();
      for (const release of releases.reverse()) await release();
    },
  };
}
function plugin() { return createDevicesPlugin({ id: DEVICES_PLUGIN_ID, version: '0.1.0', apiVersion: 2 }); }
function extensions(points: PointAccess) {
  const registered: PluginContributions[] = [];
  const events: { name: string; data: JsonValue }[] = [];
  const value: NonNullable<HostContext['extensions']> = {
    points, register: (contributions) => { registered.push(contributions); return () => {}; },
    catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
    executeCommand: async () => { throw new Error('测试不执行命令'); },
    callService: async () => { throw new Error('测试不调用服务'); },
    subscribeEvent: () => () => {},
    emitEvent: (name, data) => { events.push({ name, data }); },
    getState: () => undefined, setState() {}, subscribeState: () => () => {},
  };
  return { value, registered, events };
}

test('设备页面自行声明提供者任务操作，目录更新原位发布且不重建工作台实例', async () => {
  const registry = createWorkspaceRegistry(), devices = deviceFixture();
  const current = fixture({ devices: devices.devices });
  const ui = registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: current.host.signal });
  try {
    await plugin().activate?.({ ...current.host, ui });
    const page = ui.catalog().pages[0];
    assert.deepEqual(page?.operations, ['custom_provider.discover']);
    assert.equal(page?.taskPolicy, 'listed');
    const root = ui.snapshot().instances.find((entry) => entry.instanceId === DEVICE_WORKBENCH_INSTANCE_ID);
    const observed: number[] = [];
    const unsubscribe = ui.subscribe(() => observed.push(ui.catalog().pages.length));
    const snapshot = devices.devices.snapshot();
    devices.replace({ ...snapshot, providers: [{ ...provider, definition: { ...provider.definition,
      capabilities: [{ id: 'sample', version: 1, operation: 'third_party.device_action', scope: 'device', access: 'read' }] } }] });
    assert.deepEqual(ui.catalog().pages[0]?.operations, ['custom_provider.discover', 'third_party.device_action']);
    assert.ok(observed.every((count) => count === 1), '操作声明变化不能短暂撤销页面');
    assert.equal(ui.snapshot().instances.find((entry) => entry.instanceId === DEVICE_WORKBENCH_INSTANCE_ID)?.generation,
      root?.generation);
    const updated = ui.catalog().pages[0];
    devices.devices.select(first);
    assert.equal(ui.catalog().pages[0], updated, '仅切换设备不重复发布相同归属');
    devices.replace({ ...snapshot, providers: [] });
    assert.deepEqual(ui.catalog().pages[0]?.operations, []);
    assert.deepEqual(devices.calls, []);
    unsubscribe();
  } finally { await current.dispose(); registry.dispose(); }
  assert.equal(devices.count(), 0);
});

test('三方任务归属在设备页晚出现时等待，加载与卸载原位汇总且不重建业务视图', async () => {
  const registry = createWorkspaceRegistry(), points = createPointRegistry();
  const devices = deviceFixture(), current = fixture({ devices: devices.devices });
  const ui = registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: current.host.signal });
  const externalLifetime = new AbortController();
  const external = points.access({ pluginId: 'third_party', generation: 1, signal: externalLifetime.signal, track: (release) => release });
  external.contribute({ id: 'third_party.package_tasks', point: DEVICE_TASKS_POINT, mode: 'append',
    data: { operations: ['third_party.inspect', 'custom_provider.discover'] } });
  assert.equal(points.list(DEVICE_TASKS_POINT)[0]?.state, 'waiting');
  const ownPoints = points.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1,
    signal: current.host.signal, track: (release) => release });
  try {
    await plugin().activate?.({ ...current.host, ui, extensions: extensions(ownPoints).value });
    assert.equal(points.list(DEVICE_TASKS_POINT)[0]?.state, 'active');
    assert.deepEqual(ui.catalog().pages[0]?.operations, ['custom_provider.discover', 'third_party.inspect']);
    const root = ui.snapshot().instances.find((entry) => entry.instanceId === DEVICE_WORKBENCH_INSTANCE_ID);
    const observed: number[] = [];
    const unsubscribe = ui.subscribe(() => observed.push(ui.catalog().pages.length));
    external.contribute({ id: 'third_party.more_tasks', point: DEVICE_TASKS_POINT, mode: 'append',
      data: { operations: ['third_party.another'] } });
    assert.ok(ui.catalog().pages[0]?.operations?.includes('third_party.another'));
    externalLifetime.abort();
    assert.deepEqual(ui.catalog().pages[0]?.operations, ['custom_provider.discover']);
    assert.equal(ui.snapshot().instances.find((entry) => entry.instanceId === DEVICE_WORKBENCH_INSTANCE_ID)?.generation,
      root?.generation);
    assert.ok(observed.every((count) => count === 1));
    assert.deepEqual(devices.calls, []);
    unsubscribe();
  } finally { externalLifetime.abort(); await current.dispose(); registry.dispose(); points.dispose(); }
});

test('设备组合插件只登记默认工作台根实例，激活不并排展开目录应用或派发业务', async () => {
  const registry = createWorkspaceRegistry();
  const devices = deviceFixture();
  const current = fixture({ devices: devices.devices });
  const ui = registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: current.host.signal });
  const entry = plugin();
  assert.ok(entry.activate);
  await entry.activate({ ...current.host, ui });
  assert.equal(ui.catalog().pages[0]?.route, '/devices');
  assert.equal(ui.catalog().pages[0]?.workspaceId, DEVICES_WORKSPACE_ID);
  assert.equal(ui.catalog().pages[0]?.navigation?.group, '工作台');
  assert.equal(ui.snapshot().instances.length, 1);
  assert.equal(ui.snapshot().instances[0]?.instanceId, DEVICE_WORKBENCH_INSTANCE_ID);
  assert.equal(ui.snapshot().instances[0]?.state, 'ready');
  assert.deepEqual(ui.snapshot().instances[0]?.provider, { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_WORKBENCH_VIEW_ID });
  assert.equal(ui.catalog().views.some((view) => view.id === 'deviceforge_devices.directory'), true);
  assert.ok(ui.snapshot().instances.every((instance) => sameDevice(targetReference(instance.target), first)));
  assert.deepEqual(devices.calls, []);
  await current.dispose();
  assert.equal(devices.count(), 0);
  assert.equal(registry.catalog().pages.length, 0);
  assert.ok(registry.snapshot().instances.every((instance) => instance.reason === 'owner_inactive'));
  assert.ok(registry.hostAccess().readLayout(DEVICES_WORKSPACE_ID));
  registry.dispose();
});

test('设备组合激活迁移旧应用桥引用，保留实例布局目标和显式自选提供者', async () => {
  const registry = createWorkspaceRegistry();
  const current = fixture({ devices: deviceFixture().devices });
  const ui = registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: current.host.signal });
  const retained = `${DEVICES_PLUGIN_ID}.retained`;
  const custom = `${DEVICES_PLUGIN_ID}.custom`;
  const target = { kind: 'custom-target', value: 'unsaved' };
  const provider = { pluginId: 'third_party', viewId: 'third_party.apps' };
  ui.open({ instanceId: retained, workspaceId: DEVICES_WORKSPACE_ID, provider: LEGACY_DEVICE_APPS_VIEW,
    target, visible: false });
  ui.open({ instanceId: custom, workspaceId: DEVICES_WORKSPACE_ID, provider, target, visible: true });
  const layout = {
    version: 1 as const, root: { kind: 'view' as const, instanceId: retained },
    floating: [{ instanceId: custom, x: 10, y: 20, width: 300, height: 200, z: 1 }], overlays: [],
  };
  ui.writeLayout(DEVICES_WORKSPACE_ID, layout);
  const entry = plugin();
  assert.ok(entry.activate);
  await entry.activate({ ...current.host, ui });
  assert.equal(ui.snapshot().instances.length, 2, '已关闭的默认实例不得因迁移重新出现');
  assert.deepEqual(ui.readLayout(DEVICES_WORKSPACE_ID), layout);
  const migrated = ui.snapshot().instances.find((instance) => instance.instanceId === retained);
  assert.deepEqual(migrated?.provider, DEVICE_APPS_VIEW);
  assert.deepEqual(migrated?.target, target);
  assert.equal(migrated?.visible, false);
  assert.deepEqual(ui.snapshot().instances.find((instance) => instance.instanceId === custom)?.provider, provider);
  await current.dispose(); registry.dispose();
});

test('外部插件工具无需宿主枚举，任意视图加入工作区并继承完整设备目标', async () => {
  const registry = createWorkspaceRegistry();
  const points = createPointRegistry();
  const lifetime = new AbortController();
  const own = { pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: lifetime.signal, track: (release: Dispose) => release };
  const addon = { pluginId: 'external_tools', generation: 1, signal: new AbortController().signal, track: (release: Dispose) => release };
  const targetPoint = extensions(points.access(own));
  const contribution = points.access(addon).contribute({
    id: 'external_tools.performance', point: DEVICE_TOOLS_POINT,
    data: { title: '自定义监控', pluginId: addon.pluginId, viewId: 'external_tools.monitor' },
  });
  assert.equal(points.access(addon).list(DEVICE_TOOLS_POINT)[0]?.state, 'waiting');
  registry.access(addon).register({ views: [{ id: 'external_tools.monitor', title: '监控', mount: async () => () => {} }] });
  const devices = deviceFixture();
  const current = fixture({ devices: devices.devices, extensions: targetPoint.value, ui: registry.access(own) });
  const entry = plugin();
  assert.ok(entry.activate);
  await entry.activate(current.host);
  assert.equal(points.access(addon).list(DEVICE_TOOLS_POINT)[0]?.state, 'active');
  const id = addDeviceTool(current.host, { pluginId: addon.pluginId, viewId: 'external_tools.monitor' });
  assert.ok(references(current.host.ui?.readLayout(DEVICES_WORKSPACE_ID) ?? null, id));
  assert.equal(current.host.ui?.snapshot().instances.find((instance) => instance.instanceId === id)?.state, 'ready');
  assert.deepEqual(targetReference(current.host.ui?.snapshot().instances.find((instance) => instance.instanceId === id)?.target ?? null), first);
  devices.devices.select(second);
  assert.deepEqual(targetReference(current.host.ui?.snapshot().instances.find((instance) => instance.instanceId === id)?.target ?? null), second);
  assert.deepEqual(devices.calls, []);
  lifetime.abort();
  assert.equal(points.access(addon).list(DEVICE_TOOLS_POINT)[0]?.state, 'waiting');
  assert.ok(registry.hostAccess().readLayout(DEVICES_WORKSPACE_ID));
  await contribution.dispose();
  await current.dispose();
  points.dispose();
  registry.dispose();
});

test('插件工具加载即加入且更新不重复，撤销自动恢复原布局，无需用户组合', async () => {
  const registry = createWorkspaceRegistry(), points = createPointRegistry();
  const current = fixture({ devices: deviceFixture().devices });
  const source = { pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: current.host.signal, track: (release: Dispose) => release };
  const lifetime = new AbortController();
  const addon = { pluginId: 'automatic_tools', generation: 1, signal: lifetime.signal, track: (release: Dispose) => release };
  const addonPoints = points.access(addon);
  registry.access(addon).register({ views: [{ id: 'automatic_tools.view', title: '自动工具', mount: async () => () => {} }] });
  const handle = addonPoints.contribute({
    id: 'automatic_tools.tool', point: DEVICE_TOOLS_POINT,
    data: { title: '自动工具', pluginId: addon.pluginId, viewId: 'automatic_tools.view' },
  });
  assert.equal(addonPoints.list(DEVICE_TOOLS_POINT)[0]?.state, 'waiting');
  const ui = registry.access(source);
  const context = { ...current.host, ui, extensions: extensions(points.access(source)).value };
  const entry = plugin();
  assert.ok(entry.activate);
  try {
    await entry.activate(context);
    const added = ui.snapshot().instances.filter((instance) => instance.provider?.pluginId === addon.pluginId);
    assert.equal(added.length, 1);
    const instance = added[0];
    assert.ok(instance);
    assert.ok(references(ui.readLayout(DEVICES_WORKSPACE_ID), instance.instanceId));
    assert.deepEqual(targetReference(instance.target), first);
    handle.update({
      id: 'automatic_tools.tool', point: DEVICE_TOOLS_POINT, order: 5,
      data: { title: '更新标题', pluginId: addon.pluginId, viewId: 'automatic_tools.view' },
    });
    assert.equal(ui.snapshot().instances.filter((item) => item.provider?.pluginId === addon.pluginId).length, 1);
    assert.equal(ui.snapshot().instances.find((item) => item.instanceId === instance.instanceId)?.generation, instance.generation);
    await handle.dispose();
    assert.equal(ui.snapshot().instances.some((item) => item.instanceId === instance.instanceId), false);
    assert.deepEqual(ui.readLayout(DEVICES_WORKSPACE_ID), DEFAULT_DEVICE_LAYOUT);
  } finally {
    lifetime.abort();
    await current.dispose();
    points.dispose(); registry.dispose();
  }
});

test('插件工具撤销及新代恢复只影响所属贡献，保留其他业务实例', async () => {
  const registry = createWorkspaceRegistry(), points = createPointRegistry();
  const current = fixture();
  const source = { pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: current.host.signal, track: (release: Dispose) => release };
  const ui = registry.access(source);
  const context = { ...current.host, ui, extensions: extensions(points.access(source)).value };
  const entry = plugin();
  assert.ok(entry.activate);
  await entry.activate(context);
  function register(generation: number) {
    const controller = new AbortController();
    const owner = { pluginId: 'automatic_tools', generation, signal: controller.signal, track: (release: Dispose) => release };
    registry.access(owner).register({ views: [{ id: 'automatic_tools.view', title: '自动工具', mount: async () => () => {} }] });
    points.access(owner).contribute({
      id: 'automatic_tools.tool', point: DEVICE_TOOLS_POINT,
      data: { title: '自动工具', pluginId: owner.pluginId, viewId: 'automatic_tools.view' },
    });
    return controller;
  }
  const old = register(1);
  let next: AbortController | undefined;
  try {
    const firstInstance = ui.snapshot().instances.find((instance) => instance.provider?.pluginId === 'automatic_tools');
    assert.ok(firstInstance);
    const resolved = registry.resolveView(firstInstance.instanceId);
    assert.ok(resolved);
    old.abort();
    assert.equal(resolved.instance.signal.aborted, true);
    assert.deepEqual(ui.readLayout(DEVICES_WORKSPACE_ID), DEFAULT_DEVICE_LAYOUT);
    next = register(2);
    const replacement = ui.snapshot().instances.filter((instance) => instance.provider?.pluginId === 'automatic_tools');
    assert.equal(replacement.length, 1);
    assert.notEqual(replacement[0]?.instanceId, firstInstance.instanceId);
    assert.ok(ui.snapshot().instances.some((instance) => instance.instanceId === DEVICE_WORKBENCH_INSTANCE_ID));
    assert.equal(ui.snapshot().instances.some((instance) => instance.instanceId === DEVICE_DIRECTORY_INSTANCE_ID), false);
  } finally {
    old.abort(); next?.abort();
    await current.dispose();
    points.dispose(); registry.dispose();
  }
});

test('设备插件重载按当前贡献重新装配，不把保留布局中的自动工具重复恢复', async () => {
  const registry = createWorkspaceRegistry(), points = createPointRegistry();
  const addonLifetime = new AbortController();
  const addon = { pluginId: 'automatic_tools', generation: 1, signal: addonLifetime.signal, track: (release: Dispose) => release };
  registry.access(addon).register({ views: [{ id: 'automatic_tools.view', title: '自动工具', mount: async () => () => {} }] });
  points.access(addon).contribute({
    id: 'automatic_tools.tool', point: DEVICE_TOOLS_POINT,
    data: { title: '自动工具', pluginId: addon.pluginId, viewId: 'automatic_tools.view' },
  });
  async function activate(generation: number) {
    const current = fixture();
    const source = { pluginId: DEVICES_PLUGIN_ID, generation, signal: current.host.signal, track: (release: Dispose) => release };
    const ui = registry.access(source);
    const entry = plugin();
    assert.ok(entry.activate);
    await entry.activate({ ...current.host, ui, extensions: extensions(points.access(source)).value });
    return { current, ui };
  }
  const first = await activate(1);
  let replacement: Awaited<ReturnType<typeof activate>> | undefined;
  try {
    const instance = first.ui.snapshot().instances.find((item) => item.provider?.pluginId === addon.pluginId);
    assert.ok(instance);
    const old = registry.resolveView(instance.instanceId);
    assert.ok(old);
    await first.current.dispose();
    assert.equal(old.instance.signal.aborted, true);
    replacement = await activate(2);
    const tools = replacement.ui.snapshot().instances.filter((item) => item.provider?.pluginId === addon.pluginId);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.state, 'ready');
    assert.ok(tools[0] && references(replacement.ui.readLayout(DEVICES_WORKSPACE_ID), tools[0].instanceId));
  } finally {
    addonLifetime.abort();
    await replacement?.current.dispose();
    if (!first.current.host.signal.aborted) await first.current.dispose();
    points.dispose(); registry.dispose();
  }
});

test('公开目标服务与事件保留提供者和代次，相同localId不被当作同一设备', async () => {
  const registry = createWorkspaceRegistry();
  const points = createPointRegistry();
  const current = fixture({ devices: deviceFixture().devices });
  const source = { pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: current.host.signal, track: (release: Dispose) => release };
  const publicExtensions = extensions(points.access(source));
  const context = { ...current.host, extensions: publicExtensions.value, ui: registry.access(source) };
  const entry = plugin();
  assert.ok(entry.activate);
  await entry.activate(context);
  const service = publicExtensions.registered[0]?.services?.[0];
  assert.equal(service?.id, DEVICE_TARGET_SERVICE.id);
  assert.equal(service?.version, DEVICE_TARGET_SERVICE.version);
  assert.ok(service);
  assert.deepEqual((await service.invoke({}, context, context.signal)).data, deviceTarget(first));
  context.devices?.select(second);
  assert.deepEqual(publicExtensions.events, [{ name: DEVICE_TARGET_EVENT, data: deviceTarget(second) }]);
  assert.equal(sameDevice(first, second), false);
  assert.deepEqual((await service.invoke({}, context, context.signal)).data, deviceTarget(second));
  await current.dispose();
  points.dispose();
  registry.dispose();
});

test('目标切换撤销旧实例，外壳新视图继承设备但显式自有目标保持不变', async () => {
  const registry = createWorkspaceRegistry();
  const devices = deviceFixture();
  const current = fixture({ devices: devices.devices });
  const ui = registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: current.host.signal });
  registry.access({ pluginId: DEVICE_SCREEN_VIEW.pluginId, generation: 1, signal: current.host.signal }).register({
    views: [{ id: DEVICE_SCREEN_VIEW.viewId, title: '公开投屏视图', mount: async () => () => {} }],
  });
  const entry = plugin();
  assert.ok(entry.activate);
  await entry.activate({ ...current.host, ui });
  const old = registry.resolveView(DEVICE_WORKBENCH_INSTANCE_ID);
  assert.ok(old);
  const shell = registry.access({ pluginId: 'external_shell', generation: 1, signal: current.host.signal });
  shell.open({ instanceId: 'external_shell.inherited', workspaceId: DEVICES_WORKSPACE_ID, provider: DEVICE_SCREEN_VIEW });
  shell.open({ instanceId: 'external_shell.explicit', workspaceId: DEVICES_WORKSPACE_ID, provider: DEVICE_SCREEN_VIEW, target: { documentId: 'draft' } });
  devices.devices.select(second);
  assert.equal(old.instance.signal.aborted, true);
  assert.throws(old.instance.snapshot, /撤销/);
  assert.deepEqual(targetReference(shell.snapshot().instances.find((instance) => instance.instanceId === 'external_shell.inherited')?.target ?? null), second);
  assert.deepEqual(shell.snapshot().instances.find((instance) => instance.instanceId === 'external_shell.explicit')?.target, { documentId: 'draft' });
  devices.devices.select(null);
  assert.equal(targetReference(ui.snapshot().instances.find((instance) => instance.instanceId === DEVICE_WORKBENCH_INSTANCE_ID)?.target ?? null), null);
  await current.dispose();
  registry.dispose();
});

test('热重载保留关闭与更换选择，缺失插件布局仍在且恢复不派发业务', async () => {
  const registry = createWorkspaceRegistry();
  const devices = deviceFixture();
  const firstContext = fixture({ devices: devices.devices });
  const ui = registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: firstContext.host.signal });
  const entry = plugin();
  assert.ok(entry.activate);
  await entry.activate({ ...firstContext.host, ui });
  // 旧版显式保存的三个实例继续兼容，但不作为新版默认工作台的并排布局。
  for (const [id, provider] of [
    [DEVICE_SCREEN_INSTANCE_ID, DEVICE_SCREEN_VIEW], [DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW],
    [DEVICE_DIRECTORY_INSTANCE_ID, { pluginId: DEVICES_PLUGIN_ID, viewId: 'deviceforge_devices.directory' }],
  ] as const) ui.open({ instanceId: id, workspaceId: DEVICES_WORKSPACE_ID, provider });
  ui.writeLayout(DEVICES_WORKSPACE_ID, { version: 1, floating: [], overlays: [], root: {
    kind: 'split', direction: 'horizontal', weights: [1, 1, 1], children: [
      DEVICE_SCREEN_INSTANCE_ID, DEVICE_APPS_INSTANCE_ID, DEVICE_DIRECTORY_INSTANCE_ID,
    ].map((instanceId) => ({ kind: 'view', instanceId })),
  } });
  const custom = addDeviceTool({ ...firstContext.host, ui }, { pluginId: 'custom_view', viewId: 'custom_view.panel' });
  ui.selectProvider(DEVICE_SCREEN_INSTANCE_ID, { pluginId: 'replacement', viewId: 'replacement.screen' });
  ui.selectProvider(DEVICE_APPS_INSTANCE_ID, null);
  ui.close(DEVICE_DIRECTORY_INSTANCE_ID);
  const saved = registry.save();
  await firstContext.dispose();
  registry.dispose();
  const restored = createWorkspaceRegistry();
  restored.restore(saved);
  const secondContext = fixture({ devices: devices.devices });
  const nextUi = restored.access({ pluginId: DEVICES_PLUGIN_ID, generation: 2, signal: secondContext.host.signal });
  await entry.activate({ ...secondContext.host, ui: nextUi });
  assert.equal(nextUi.snapshot().instances.some((instance) => instance.instanceId === DEVICE_DIRECTORY_INSTANCE_ID), false);
  assert.equal(nextUi.snapshot().instances.find((instance) => instance.instanceId === DEVICE_SCREEN_INSTANCE_ID)?.provider?.pluginId, 'replacement');
  assert.equal(nextUi.snapshot().instances.find((instance) => instance.instanceId === DEVICE_APPS_INSTANCE_ID)?.provider, null);
  assert.equal(nextUi.snapshot().instances.find((instance) => instance.instanceId === custom)?.reason, 'provider_missing');
  assert.ok(references(nextUi.readLayout(DEVICES_WORKSPACE_ID), custom));
  assert.deepEqual(devices.calls, []);
  await secondContext.dispose();
  restored.dispose();
});

test('设备目录显式刷新与发现才读取后端，不在实例创建时启动业务', async () => {
  const devices = deviceFixture();
  const context = fixture({ devices: devices.devices });
  const model = createDeviceDirectory(context.host);
  assert.deepEqual(devices.calls, []);
  await model.refresh();
  assert.deepEqual(devices.calls, ['providers', 'directories']);
  assert.equal(model.snapshot().feedback?.message, '读取设备目录已完成');
  assert.equal(model.snapshot().feedback?.logId, 'directory-log');
  await model.discover(provider);
  assert.deepEqual(devices.calls, ['providers', 'directories', 'discover']);
  assert.equal(model.snapshot().feedback?.logId, 'discovery-log');
  await model.dispose();
  assert.equal(devices.count(), 0);
  await context.dispose();
});

test('目标切换取消目录等待，即使旧提供者忽略取消也不覆盖新回执', async () => {
  const devices = deviceFixture();
  const late = deferred<HostResult<DeviceDirectory>>();
  const observed: AbortSignal[] = [];
  const context = fixture({
    devices: {
      ...devices.devices,
      refreshProvider: async (_id, _generation, signal) => {
        observed.push(signal);
        return late.promise;
      },
    },
  });
  const model = createDeviceDirectory(context.host);
  const old = model.discover(provider);
  assert.equal(model.snapshot().pending, '发现设备');
  devices.devices.select(second);
  assert.equal(model.snapshot().pending, null);
  await old;
  assert.equal(observed[0]?.aborted, true);
  await model.refresh();
  assert.equal(model.snapshot().feedback?.logId, 'directory-log');
  late.resolve({ data: directory, logId: 'stale-log' });
  await Promise.resolve();
  assert.equal(model.snapshot().feedback?.logId, 'directory-log');
  assert.deepEqual(model.snapshot().devices.selection, second);
  await model.dispose();
  await context.dispose();
});

test('目录失败保留日志且后续独立操作可继续，销毁取消从不返回的等待', async () => {
  const devices = deviceFixture();
  let failing = true;
  const context = fixture({
    devices: {
      ...devices.devices,
      refreshProvider: async () => {
        if (failing) throw Object.assign(new Error('提供者本次发现失败'), { logId: 'failed-log' });
        return new Promise<HostResult<DeviceDirectory>>(() => {});
      },
    },
  });
  const model = createDeviceDirectory(context.host);
  await model.discover(provider);
  assert.equal(model.snapshot().feedback?.outcome, 'failed');
  assert.equal(model.snapshot().feedback?.logId, 'failed-log');
  await model.refresh();
  assert.equal(model.snapshot().feedback?.outcome, 'completed');
  failing = false;
  const waiting = model.discover(provider);
  await model.dispose();
  await waiting;
  assert.equal(devices.count(), 0);
  await context.dispose();
});

test('单个目录订阅抛错不阻断其他视图或下一次独立请求', async () => {
  const devices = deviceFixture();
  const context = fixture({ devices: devices.devices });
  const model = createDeviceDirectory(context.host);
  let observations = 0;
  model.subscribe(() => { throw new Error('一个独立视图渲染失败'); });
  model.subscribe(() => { observations++; });
  await model.refresh();
  assert.equal(model.snapshot().feedback?.outcome, 'completed');
  await model.discover(provider);
  assert.equal(model.snapshot().feedback?.logId, 'discovery-log');
  assert.equal(observations, 4);
  await model.dispose();
  await context.dispose();
});
