import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceRegistry, scopedWorkspaceAccess } from '../src/plugins/workspace/index.ts';

function fixture() {
  const registry = createWorkspaceRegistry(), lifetime = new AbortController();
  const access = registry.access({ pluginId: 'example', generation: 1, signal: lifetime.signal });
  const release = access.register({ pages: [{ id: 'example.page', title: '原页面', route: '/example',
    mount: async () => () => {}, operations: ['example.read'], taskPolicy: 'listed' }] });
  return { registry, lifetime, access, release };
}

test('原位更新页面元数据不撤销页面或重建实例，原登记释放仍能撤销更新后的条目', async () => {
  const { registry, access, release } = fixture();
  try {
    const update = access.updatePage; assert.ok(update);
    const before = access.open({ instanceId: 'example.main', workspaceId: 'example.page',
      provider: { pluginId: 'example', viewId: 'example.page' } });
    const mountedSignal = registry.resolveView('example.main')?.instance.signal;
    assert.ok(mountedSignal);
    const observations: number[] = [];
    const unsubscribe = access.subscribe(() => observations.push(access.catalog().pages.length));
    const operations = ['example.write'], navigation = { order: 12, description: '原业务页面' };
    update('example.page', { title: '设备任务', operations, navigation, taskPolicy: 'listed' });
    operations.push('not.registered'); navigation.order = 99;
    assert.deepEqual(observations, [1]);
    assert.deepEqual(access.catalog().pages[0]?.operations, ['example.write']);
    assert.equal(access.catalog().pages[0]?.navigation?.order, 12);
    assert.equal(access.catalog().pages[0]?.route, '/example');
    assert.equal(access.catalog().views[0]?.title, '设备任务');
    assert.equal(Object.isFrozen(access.catalog().pages[0]?.operations), true);
    const after = access.snapshot().instances[0];
    assert.equal(after?.generation, before.generation);
    assert.equal(registry.resolveView('example.main')?.instance.signal, mountedSignal);
    assert.equal(mountedSignal.aborted, false);
    unsubscribe(); await release();
    assert.equal(access.catalog().pages.length, 0);
    assert.equal(access.catalog().views.length, 0);
    assert.equal(access.snapshot().instances[0]?.state, 'missing');
  } finally { registry.dispose(); }
});

test('页面更新拒绝跨所属代次和路由挂载改写，非法元数据原子失败而不影响独立新更新', () => {
  const { registry, access } = fixture();
  try {
    const update = access.updatePage; assert.ok(update);
    const other = registry.access({ pluginId: 'example', generation: 2, signal: new AbortController().signal });
    assert.ok(other.updatePage);
    assert.throws(() => other.updatePage?.('example.page', { operations: ['example.steal'] }), /作用域|所属/);
    const before = access.snapshot();
    assert.throws(() => Reflect.apply(update, access, ['example.page', { route: '/wrong' }]), /元数据/);
    assert.throws(() => Reflect.apply(update, access, ['example.page', { mount: () => undefined }]), /元数据/);
    assert.throws(() => update('example.page', { operations: ['duplicate', 'duplicate'] }), /操作/);
    assert.equal(access.snapshot(), before);
    update('example.page', { operations: [], taskPolicy: 'all' });
    assert.deepEqual(access.catalog().pages[0]?.operations, []);
    assert.equal(access.catalog().pages[0]?.taskPolicy, 'all');
  } finally { registry.dispose(); }
});

test('撤销旧登记后的晚到更新不能覆盖同标识新页面', async () => {
  const { registry, access, release } = fixture();
  try {
    const update = access.updatePage; assert.ok(update);
    await release();
    const next = registry.access({ pluginId: 'example', generation: 2, signal: new AbortController().signal });
    next.register({ pages: [{ id: 'example.page', title: '新代', route: '/example',
      mount: async () => () => {}, operations: ['example.new'] }] });
    assert.throws(() => update('example.page', { operations: ['example.old'] }), /作用域|所属/);
    assert.deepEqual(next.catalog().pages[0]?.operations, ['example.new']);
  } finally { registry.dispose(); }
});

test('子作用域撤销后不能更新页面，旧宿主可缺省原位更新能力', () => {
  const { registry, access } = fixture();
  try {
    const lifetime = new AbortController();
    const scoped = scopedWorkspaceAccess(access, lifetime.signal, (release) => release);
    assert.ok(scoped.updatePage);
    scoped.updatePage('example.page', { operations: ['example.child'] });
    lifetime.abort();
    assert.throws(() => scoped.updatePage?.('example.page', { operations: ['example.late'] }), /作用域/);
    const { updatePage: _update, ...legacy } = access;
    const old = scopedWorkspaceAccess(legacy, new AbortController().signal, (release) => release);
    assert.equal(old.updatePage, undefined);
    access.updatePage?.('example.page', { operations: ['example.root'] });
    assert.deepEqual(access.catalog().pages[0]?.operations, ['example.root']);
  } finally { registry.dispose(); }
});
