import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import type { WorkspacePageDefinition } from '../src/plugin-sdk/workspace.ts';

function fixture() {
  const registry = createWorkspaceRegistry();
  const lifetime = new AbortController();
  const access = registry.access({ pluginId: 'example', generation: 1, signal: lifetime.signal });
  return { registry, lifetime, access };
}

test('跨提供者同址保留来源用于冲突诊断，同一提供者重复路径仍原子拒绝', async () => {
  const registry = createWorkspaceRegistry();
  const lifetime = new AbortController();
  const a = registry.access({ pluginId: 'a', generation: 1, signal: lifetime.signal });
  const b = registry.access({ pluginId: 'b', generation: 1, signal: lifetime.signal });
  const mount: WorkspacePageDefinition['mount'] = async () => () => {};
  try {
    const release = a.register({ pages: [{ id: 'a.page', title: '甲', route: '/same', mount }] });
    b.register({ pages: [{ id: 'b.page', title: '乙', route: '/same', mount }] });
    assert.equal(registry.catalog().pages.length, 2);
    assert.throws(() => a.register({ pages: [{ id: 'a.other', title: '重复', route: '/same', mount }] }), /路由重复/);
    assert.equal(registry.catalog().pages.length, 2);
    await release();
    assert.deepEqual(registry.catalog().pages.map((entry) => entry.pluginId), ['b']);
  } finally { registry.dispose(); }
});

test('页面挂载通过同一公开视图目录可发现并随提供者撤销', () => {
  const { registry, access, lifetime } = fixture();
  const mount: WorkspacePageDefinition['mount'] = async () => () => {};
  access.register({ pages: [{ id: 'example.page', title: '示例', route: '/example', mount }] });
  const page = access.catalog().pages[0];
  assert.equal(page?.viewId, 'example.page');
  assert.deepEqual(access.catalog().views.map((view) => view.id), ['example.page']);
  access.open({
    instanceId: 'example.instance', workspaceId: 'example.page',
    provider: { pluginId: 'example', viewId: 'example.page' },
  });
  const resolved = registry.resolveView('example.instance');
  assert.equal(resolved?.definition.mount, mount);
  lifetime.abort();
  assert.equal(resolved?.instance.signal.aborted, true);
  assert.equal(registry.catalog().pages.length, 0);
  assert.equal(registry.catalog().views.length, 0);
  assert.equal(registry.snapshot().instances[0]?.state, 'missing');
  registry.dispose();
});

test('页面导航与任务归属是不可变公开元数据，工作区页面无需挂载函数', () => {
  const { registry, access } = fixture();
  const navigation = { group: '工作台', order: 20, icon: 'folder', hidden: false, description: '插件文件工作区' };
  const operations = ['example.read', 'example.write'];
  access.register({
    workspaces: [{ id: 'example.workspace', title: '示例工作区' }],
    pages: [{
      id: 'example.page', title: '示例', route: '/example', workspaceId: 'example.workspace',
      navigation, operations, taskPolicy: 'listed',
    }],
  });
  navigation.group = '外部修改';
  operations.push('unregistered.operation');
  const page = access.catalog().pages[0];
  assert.equal(page?.viewId, null);
  assert.equal(page?.navigation?.group, '工作台');
  assert.deepEqual(page?.operations, ['example.read', 'example.write']);
  assert.equal(page?.taskPolicy, 'listed');
  assert.equal(Object.isFrozen(page?.navigation), true);
  registry.dispose();
});

test('页面挂载与显式视图标识冲突时整批登记原子拒绝', () => {
  const { registry, access } = fixture();
  assert.throws(() => access.register({
    pages: [{ id: 'example.same', title: '页面', route: '/same', mount: async () => () => {} }],
    views: [{ id: 'example.same', title: '视图', mount: async () => () => {} }],
  }), /重复/);
  assert.equal(access.catalog().pages.length, 0);
  assert.equal(access.catalog().views.length, 0);
  registry.dispose();
});

test('错误导航或任务元数据不进入目录，也不影响后续独立登记', () => {
  const { registry, access } = fixture();
  assert.throws(() => access.register({ pages: [{
    id: 'example.bad', title: '错误', route: '/bad', mount: async () => () => {},
    navigation: { order: Number.NaN },
  }] }), /导航/);
  assert.throws(() => access.register({ pages: [{
    id: 'example.bad', title: '错误', route: '/bad', mount: async () => () => {},
    operations: ['contains space'],
  }] }), /操作/);
  access.register({ pages: [{
    id: 'example.good', title: '正常', route: '/good', mount: async () => () => {},
    taskPolicy: 'all',
  }] });
  assert.equal(access.catalog().pages.length, 1);
  assert.equal(access.catalog().pages[0]?.taskPolicy, 'all');
  registry.dispose();
});
