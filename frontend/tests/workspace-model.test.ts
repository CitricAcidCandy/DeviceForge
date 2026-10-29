import assert from 'node:assert/strict';
import test from 'node:test';
import type { Dispose } from '../src/plugin-sdk/models.ts';
import type { WorkspaceLayout, WorkspaceMount } from '../src/plugin-sdk/workspace.ts';
import { createWorkspaceRegistry, scopedWorkspaceAccess, validateWorkspaceLayout } from '../src/plugins/workspace/index.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';

const mount: WorkspaceMount = async () => () => {};
const empty: WorkspaceLayout = { version: 1, root: null, floating: [], overlays: [] };
function owner(pluginId: string, generation = 1) {
  const controller = new AbortController();
  return { pluginId, generation, signal: controller.signal, controller };
}
function viewLayout(instanceId: string): WorkspaceLayout {
  return { ...empty, root: { kind: 'view', instanceId } };
}

test('注册目录不泄漏挂载函数，快照冻结且稳定，撤销不擦除布局', () => {
  const registry = createWorkspaceRegistry();
  const source = owner('official');
  const ui = registry.access(source);
  const release = ui.register({
    pages: [{ id: 'official.page', title: '页面', route: '/custom', workspaceId: 'official.workspace' }],
    workspaces: [{ id: 'official.workspace', title: '工作区', defaultLayout: empty }],
    views: [{ id: 'official.view', title: '视图', mount }],
  });
  assert.equal(ui.catalog(), ui.catalog());
  assert.equal(ui.snapshot(), ui.snapshot());
  assert.equal(JSON.stringify(ui.catalog()).includes('mount'), false);
  assert.ok(Object.isFrozen(ui.catalog().pages));
  ui.writeLayout('official.workspace', empty);
  release();
  assert.equal(ui.catalog().pages.length, 0);
  assert.deepEqual(ui.readLayout('official.workspace'), empty);
  registry.dispose();
});

test('打开明确选择提供者，多个插件提供同类视图时不按加载顺序抢占', () => {
  const registry = createWorkspaceRegistry();
  const ui = registry.access(owner('consumer'));
  registry.access(owner('first')).register({ views: [{ id: 'first.view', title: '首个', provides: ['shell'], mount }] });
  registry.access(owner('second')).register({ views: [{ id: 'second.view', title: '另一个', provides: ['shell'], mount }] });
  const input = { instanceId: 'consumer.main', workspaceId: 'consumer.work', provider: null };
  assert.equal(ui.open(input).state, 'unselected');
  assert.equal(registry.resolveView('consumer.main'), null);
  const selected = ui.selectProvider('consumer.main', { pluginId: 'second', viewId: 'second.view' });
  assert.equal(selected.state, 'ready');
  assert.equal(registry.resolveView('consumer.main')?.definition.title, '另一个');
  assert.equal(ui.snapshot().instances[0]?.provider?.pluginId, 'second');
  registry.dispose();
});

test('视图多实例互相隔离，切换目标撤销旧运行上下文，隐藏只通知可见性', () => {
  const registry = createWorkspaceRegistry();
  const ui = registry.access(owner('plugin'));
  ui.register({ views: [{ id: 'plugin.view', title: '视图', mount }] });
  const provider = { pluginId: 'plugin', viewId: 'plugin.view' };
  const a = ui.open({ instanceId: 'plugin.a', workspaceId: 'plugin.work', provider, target: { id: 'a' } });
  const b = ui.open({ instanceId: 'plugin.b', workspaceId: 'plugin.work', provider, target: { id: 'b' } });
  const running = registry.resolveView(a.instanceId);
  const other = registry.resolveView(b.instanceId);
  assert.ok(running && other);
  const visibility: boolean[] = [];
  running.instance.subscribeVisibility((value) => visibility.push(value));
  ui.setVisible(a.instanceId, false);
  assert.deepEqual(visibility, [false]);
  assert.equal(running.instance.signal.aborted, false);
  assert.equal(ui.snapshot().instances[0]?.generation, a.generation);
  const next = ui.setTarget(a.instanceId, { id: 'new' });
  assert.ok(next.generation > a.generation);
  assert.equal(running.instance.signal.aborted, true);
  assert.equal(other.instance.signal.aborted, false);
  assert.throws(() => running.instance.snapshot(), /已撤销/);
  registry.dispose();
});

test('提供者缺失保留实例及布局，恢复只更新目录，不自动调用业务挂载', () => {
  const registry = createWorkspaceRegistry();
  const ui = registry.access(owner('consumer'));
  let mounts = 0;
  const provider = { pluginId: 'provider', viewId: 'provider.view' };
  ui.open({ instanceId: 'consumer.one', workspaceId: 'consumer.work', provider });
  ui.writeLayout('consumer.work', viewLayout('consumer.one'));
  assert.equal(ui.snapshot().instances[0]?.reason, 'provider_missing');
  const first = owner('provider');
  registry.access(first).register({ views: [{ id: provider.viewId, title: '视图', mount: async () => { mounts++; return () => {}; } }] });
  const running = registry.resolveView('consumer.one');
  assert.ok(running);
  first.controller.abort();
  assert.equal(running.instance.signal.aborted, true);
  assert.equal(ui.snapshot().instances[0]?.state, 'missing');
  assert.deepEqual(ui.readLayout('consumer.work'), viewLayout('consumer.one'));
  registry.access(owner('provider', 2)).register({ views: [{ id: provider.viewId, title: '新版视图', mount }] });
  assert.equal(ui.snapshot().instances[0]?.providerGeneration, 2);
  assert.equal(mounts, 0);
  registry.dispose();
});

test('保存只含 JSON，恢复不带运行资格，显式重接后新代可用', () => {
  const registry = createWorkspaceRegistry();
  const source = owner('plugin');
  const ui = registry.access(source);
  ui.register({ views: [{ id: 'plugin.view', title: '视图', mount }] });
  const input = { instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: { pluginId: 'plugin', viewId: 'plugin.view' }, target: { id: 1 } };
  const original = ui.open(input);
  ui.writeLayout('plugin.work', viewLayout('plugin.a'));
  const previous = registry.resolveView('plugin.a');
  assert.ok(previous);
  const saved = JSON.stringify(registry.save());
  assert.equal(saved.includes('generation'), false);
  assert.equal(saved.includes('mount'), false);
  const unknownSaved: unknown = JSON.parse(saved);
  registry.restore(unknownSaved);
  assert.equal(previous.instance.signal.aborted, true);
  assert.equal(ui.snapshot().instances[0]?.reason, 'owner_inactive');
  assert.equal(registry.resolveView('plugin.a'), null);
  const next = ui.open(input);
  assert.ok(next.generation > original.generation);
  assert.equal(next.state, 'ready');
  const before = ui.snapshot();
  assert.throws(() => registry.restore({ version: 1, instances: [], layouts: [{ workspaceId: 'plugin.work', layout: { version: 9 } }] }), /布局/);
  assert.equal(ui.snapshot(), before);
  registry.dispose();
});

test('布局验证覆盖分栏页签、浮窗覆盖层、自定义节点与重复实例', () => {
  const good: WorkspaceLayout = {
    version: 1,
    root: { kind: 'split', direction: 'horizontal', weights: [3, 1], children: [
      { kind: 'tabs', active: 'main', items: [{ id: 'main', node: { kind: 'view', instanceId: 'plugin.a' } }] },
      { kind: 'custom', provider: { pluginId: 'plugin', viewId: 'plugin.layout' }, data: { count: 3 } },
    ] },
    floating: [{ instanceId: 'plugin.b', x: -10, y: 2, width: 300, height: 200, z: 1 }],
    overlays: [{ instanceId: 'plugin.c', relativeTo: 'plugin.a', x: 2, y: 3, width: 100, height: 100, z: 2 }],
  };
  validateWorkspaceLayout(good);
  assert.throws(() => validateWorkspaceLayout({ ...good, floating: [{ ...good.floating[0], instanceId: 'plugin.a' }] }), /多个布局位置/);
  assert.throws(() => validateWorkspaceLayout({ ...good, root: { kind: 'split', direction: 'horizontal', weights: [0, 1], children: [good.root, good.root] } }), /权重/);
  assert.throws(() => validateWorkspaceLayout({ ...good, floating: [{ ...good.floating[0], width: Infinity }] }), /JSON/);
  assert.throws(() => validateWorkspaceLayout({ ...good, root: { kind: 'tabs', active: 'missing', items: [] } }), /活动页签/);
  assert.throws(() => validateWorkspaceLayout({ ...good, root: { kind: 'view', instanceId: 'bad id' } }), /标识/);
});

test('显式关闭修剪布局，批量注册失败保持原目录，调用方不能修改快照', () => {
  const registry = createWorkspaceRegistry();
  const ui = registry.access(owner('plugin'));
  ui.register({ views: [{ id: 'plugin.view', title: '视图', mount }] });
  const provider = { pluginId: 'plugin', viewId: 'plugin.view' };
  ui.open({ instanceId: 'plugin.a', workspaceId: 'plugin.work', provider });
  ui.open({ instanceId: 'plugin.b', workspaceId: 'plugin.work', provider });
  ui.writeLayout('plugin.work', { ...empty, root: { kind: 'split', direction: 'vertical', weights: [1, 1], children: [
    { kind: 'view', instanceId: 'plugin.a' }, { kind: 'view', instanceId: 'plugin.b' },
  ] } });
  const snapshot = ui.snapshot();
  assert.throws(() => ui.register({ views: [{ id: 'plugin.ok', title: '可用', mount }, { id: 'other.bad', title: '越权', mount }] }), /命名空间/);
  assert.equal(ui.snapshot(), snapshot);
  assert.equal(ui.catalog().views.length, 1);
  assert.ok(Object.isFrozen(snapshot.instances[0]));
  ui.close('plugin.a');
  assert.deepEqual(ui.readLayout('plugin.work'), viewLayout('plugin.b'));
  assert.equal(ui.snapshot().instances.length, 1);
  const running = registry.resolveView('plugin.b');
  assert.ok(running);
  registry.dispose();
  assert.equal(running.instance.signal.aborted, true);
  assert.throws(() => ui.catalog(), /已关闭/);
});

test('直接 scope 包装跟随显式调用信号，取消后不重放实例动作', () => {
  const registry = createWorkspaceRegistry();
  const ui = registry.access(owner('plugin'));
  const scope = new AbortController();
  const resources: Dispose[] = [];
  const scoped = scopedWorkspaceAccess(ui, scope.signal, (release) => { resources.push(release); return release; });
  scoped.register({ views: [{ id: 'plugin.view', title: '视图', mount }] });
  const cancel = new AbortController();
  scoped.open({ instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: { pluginId: 'plugin', viewId: 'plugin.view' } }, cancel.signal);
  cancel.abort();
  assert.equal(ui.snapshot().instances[0]?.reason, 'owner_inactive');
  scope.abort();
  for (const release of resources) release();
  assert.equal(ui.catalog().views.length, 0);
  assert.throws(() => scoped.open({ instanceId: 'plugin.b', workspaceId: 'plugin.work', provider: null }), /已撤销/);
  registry.dispose();
});

test('旧代撤销不删除新注册，旧 opener 信号不能终止复用的实例', () => {
  const registry = createWorkspaceRegistry();
  const first = owner('plugin');
  const firstUi = registry.access(first);
  const oldRelease = firstUi.register({ views: [{ id: 'plugin.view', title: '旧', mount }] });
  const input = { instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: { pluginId: 'plugin', viewId: 'plugin.view' } };
  firstUi.open(input);
  first.controller.abort();
  const next = owner('plugin', 2);
  const nextUi = registry.access(next);
  nextUi.register({ views: [{ id: 'plugin.view', title: '新', mount }] });
  nextUi.open(input);
  oldRelease();
  assert.equal(nextUi.catalog().views[0]?.title, '新');
  assert.equal(nextUi.snapshot().instances[0]?.state, 'ready');
  assert.throws(() => firstUi.setTarget(input.instanceId, null), /已撤销/);
  registry.dispose();
});

test('子作用域真实关闭撤销注册和运行实例，持久布局及其他实例保留', async () => {
  const registry = createWorkspaceRegistry();
  const source = owner('plugin');
  const ui = registry.access(source);
  ui.register({ views: [{ id: 'plugin.view', title: '父视图', mount }] });
  const host: HostContext = {
    apiVersion: 2, signal: source.signal, ui,
    listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('本用例不提交任务'); },
    getJob: async () => { throw new Error('本用例不查询任务'); },
    cancelJob: async () => { throw new Error('本用例不取消任务'); },
    subscribeOperations: () => () => {}, onDispose: (dispose) => dispose,
  };
  const child = createPluginScope(host);
  const nested = child.context.ui;
  assert.ok(nested);
  nested.register({ views: [{ id: 'plugin.child', title: '子视图', mount }] });
  nested.open({ instanceId: 'plugin.child-instance', workspaceId: 'plugin.work', provider: { pluginId: 'plugin', viewId: 'plugin.view' } });
  ui.open({ instanceId: 'plugin.parent-instance', workspaceId: 'plugin.work', provider: { pluginId: 'plugin', viewId: 'plugin.view' } });
  ui.writeLayout('plugin.work', viewLayout('plugin.child-instance'));
  const running = registry.resolveView('plugin.child-instance');
  const other = registry.resolveView('plugin.parent-instance');
  assert.ok(running && other);
  await child.dispose();
  assert.equal(running.instance.signal.aborted, true);
  assert.equal(other.instance.signal.aborted, false);
  assert.equal(ui.catalog().views.length, 1);
  assert.equal(ui.snapshot().instances.find((item) => item.instanceId === 'plugin.child-instance')?.reason, 'owner_inactive');
  assert.deepEqual(ui.readLayout('plugin.work'), viewLayout('plugin.child-instance'));
  assert.throws(() => nested.writeLayout('plugin.work', empty), /已撤销/);
  registry.dispose();
});

test('保存数据限制运行字段，恢复发布一次，重接保留目标与可见性', () => {
  const registry = createWorkspaceRegistry();
  const first = owner('plugin');
  const ui = registry.access(first);
  const input = { instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: null };
  ui.open({ ...input, target: { file: 'draft' }, visible: false });
  ui.writeLayout('plugin.work', viewLayout(input.instanceId));
  const saved = registry.save();
  let notifications = 0;
  registry.hostAccess().subscribe(() => { notifications++; });
  registry.restore(saved);
  assert.equal(notifications, 1);
  const restored = ui.open(input);
  assert.deepEqual(restored.target, { file: 'draft' });
  assert.equal(restored.visible, false);
  assert.throws(() => registry.restore({ ...saved, instances: [{ ...saved.instances[0], generation: 3 }] }), /运行时/);
  assert.deepEqual(ui.readLayout('plugin.work'), viewLayout(input.instanceId));
  registry.dispose();
});

test('布局容量也约束默认布局登记，循环目标不会污染现有实例', () => {
  const registry = createWorkspaceRegistry();
  const ui = registry.access(owner('plugin'));
  for (let index = 0; index < 128; index++) ui.writeLayout(`plugin.work${index}`, empty);
  assert.throws(() => ui.register({ workspaces: [{ id: 'plugin.excess', title: '额外工作区', defaultLayout: empty }] }), /数量超过限制/);
  assert.equal(ui.catalog().workspaces.length, 0);
  const input = { instanceId: 'plugin.a', workspaceId: 'plugin.work0', provider: null };
  ui.open(input);
  const before = ui.snapshot();
  const cyclic: { [key: string]: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => validateWorkspaceLayout({ ...empty, root: { kind: 'custom', provider: { pluginId: 'plugin', viewId: 'plugin.custom' }, data: cyclic } }), /JSON/);
  assert.equal(ui.snapshot(), before);
  registry.dispose();
});

test('跨工作区布局不能复用同一实例，未知提供者的合法占位仍可保存', () => {
  const registry = createWorkspaceRegistry();
  const ui = registry.access(owner('plugin'));
  ui.open({ instanceId: 'plugin.a', workspaceId: 'plugin.first', provider: null });
  assert.throws(() => ui.writeLayout('plugin.second', viewLayout('plugin.a')), /其他工作区/);
  ui.writeLayout('plugin.second', viewLayout('plugin.future'));
  assert.throws(() => ui.open({ instanceId: 'plugin.future', workspaceId: 'plugin.first', provider: null }), /其他工作区/);
  assert.throws(() => registry.restore({ version: 1,
    instances: [{ pluginId: 'plugin', instanceId: 'plugin.a', workspaceId: 'plugin.first', provider: null }],
    layouts: [{ workspaceId: 'plugin.second', layout: viewLayout('plugin.a') }],
  }), /其他工作区/);
  assert.deepEqual(ui.readLayout('plugin.second'), viewLayout('plugin.future'));
  assert.equal(ui.open({ instanceId: 'plugin.future', workspaceId: 'plugin.second', provider: null }).state, 'unselected');
  registry.dispose();
});
