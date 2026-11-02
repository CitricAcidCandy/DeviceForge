import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { createPointRegistry, scopedPointAccess } from '../src/plugins/points/index.ts';
import type { PointContribution, PointRef } from '../src/plugin-sdk/points.ts';
import type { Dispose } from '../src/plugin-sdk/models.ts';

const point: PointRef = { id: 'workbench.tools', version: '1' };

test('只读选择意图与当前可用选择分离，子作用域撤销后不能读取且旧宿主可缺省', () => {
  const registry = createPointRegistry(), provider = owner('workbench'), addon = owner('addon');
  const access = registry.access(provider);
  access.define({ ...point, title: '工具', modes: ['replace'] });
  const handle = registry.access(addon).contribute(contribution('addon.replace', { mode: 'replace' }));
  access.select(point, 'addon.replace');
  assert.equal(access.selection?.(point), 'addon.replace');
  handle.dispose();
  assert.equal(access.selected(point), null); assert.equal(access.selection?.(point), 'addon.replace');
  access.select(point, null); assert.equal(access.selection?.(point), null);
  const child = owner('child'); const scoped = scopedPointAccess(access, child.signal, child.track);
  assert.equal(scoped.selection?.(point), null); child.close();
  assert.throws(() => scoped.selection?.(point));
  const { selection: _selection, ...legacy } = access;
  const old = scopedPointAccess(legacy, provider.signal, provider.track);
  assert.equal(old.selection, undefined);
  registry.dispose();
});
function owner(pluginId: string, generation = 1) {
  const controller = new AbortController();
  const releases = new Set<Dispose>();
  return {
    pluginId, generation, signal: controller.signal,
    track(release: Dispose) { releases.add(release); return release; },
    close() { controller.abort(); },
  };
}
function contribution(id: string, options: Partial<PointContribution> = {}): PointContribution {
  return { id, point, data: { title: '测试' }, ...options };
}

test('贡献可先于目标扩展点出现，定义、卸载和恢复只改变相应状态', () => {
  const registry = createPointRegistry();
  const consumer = registry.access(owner('addon'));
  const provider = owner('workbench');
  consumer.contribute(contribution('addon.panel'));
  assert.equal(consumer.list(point)[0]?.state, 'waiting');
  registry.access(provider).define({ ...point, title: '工具' });
  assert.equal(consumer.list(point)[0]?.state, 'active');
  provider.close();
  assert.equal(consumer.list(point)[0]?.state, 'waiting');
  registry.access(owner('workbench', 2)).define({ ...point, title: '新工具' });
  assert.equal(consumer.list(point)[0]?.state, 'active');
  registry.dispose();
});

test('版本精确匹配且定义不隐式升级旧贡献', () => {
  const registry = createPointRegistry();
  const access = registry.access(owner('workbench'));
  access.define({ ...point, title: '工具' });
  access.contribute(contribution('workbench.a', { point: { ...point, version: '1.0' } }));
  assert.equal(access.list({ ...point, version: '1.0' })[0]?.state, 'version_mismatch');
  assert.equal(access.list(point).length, 0);
  registry.dispose();
});

test('注册和更新检查命名空间及重复身份，失败不修改已登记内容', () => {
  const registry = createPointRegistry();
  const access = registry.access(owner('addon'));
  assert.throws(() => access.define({ ...point, title: '越界' }), /命名空间/);
  assert.throws(() => access.contribute(contribution('other.panel')), /命名空间/);
  const handle = access.contribute(contribution('addon.panel'));
  assert.throws(() => access.contribute(contribution('addon.panel')), /重复/);
  assert.throws(() => handle.update(contribution('addon.other')), /标识/);
  assert.deepEqual(access.list(point)[0]?.data, { title: '测试' });
  assert.throws(() => handle.update(contribution('addon.panel', { order: Number.NaN })), /顺序/);
  registry.dispose();
});

test('追加顺序稳定且替换只能显式选择，不按加载先后抢占', () => {
  const registry = createPointRegistry();
  const access = registry.access(owner('workbench'));
  access.define({ ...point, title: '工具' });
  access.contribute(contribution('workbench.z', { order: 10 }));
  access.contribute(contribution('workbench.b', { order: 0 }));
  access.contribute(contribution('workbench.a', { order: 0 }));
  const first = access.contribute(contribution('workbench.first', { mode: 'replace' }));
  const last = access.contribute(contribution('workbench.last', { mode: 'replace' }));
  assert.equal(access.selected(point), null);
  access.select(point, 'workbench.first');
  assert.equal(access.selected(point)?.id, 'workbench.first');
  assert.deepEqual(access.list(point).filter((entry) => entry.mode === 'append').map((entry) => entry.id),
    ['workbench.a', 'workbench.b', 'workbench.z']);
  last.update(contribution('workbench.last', { mode: 'replace', order: -10 }));
  assert.equal(access.selected(point)?.id, 'workbench.first');
  assert.throws(() => access.select(point, 'workbench.a'), /替换/);
  first.dispose();
  assert.equal(access.selected(point), null);
  access.contribute(contribution('workbench.first', { mode: 'replace' }));
  assert.equal(access.selected(point)?.id, 'workbench.first');
  access.select(point, null);
  assert.equal(access.selected(point), null);
  registry.dispose();
});

test('定义出现后和数据更新后均校验 Schema，非法模式可诊断但不激活', () => {
  const registry = createPointRegistry();
  const access = registry.access(owner('workbench'));
  const handle = access.contribute(contribution('workbench.panel', { data: { title: 7 } }));
  access.define({ ...point, title: '工具', modes: ['append'], inputSchema: {
    type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false,
  } });
  assert.equal(access.list(point)[0]?.state, 'invalid');
  assert.equal(access.list(point)[0]?.reason, 'data_invalid');
  handle.update(contribution('workbench.panel'));
  assert.equal(access.list(point)[0]?.state, 'active');
  handle.update(contribution('workbench.panel', { mode: 'replace' }));
  assert.equal(access.list(point)[0]?.reason, 'mode_not_allowed');
  assert.throws(() => access.select(point, 'workbench.panel'), /可用/);
  registry.dispose();
});

test('旧代释放不得撤销新代同名贡献，已撤销句柄不能更新', () => {
  const registry = createPointRegistry();
  const oldOwner = owner('addon');
  const old = registry.access(oldOwner).contribute(contribution('addon.panel'));
  oldOwner.close();
  const current = registry.access(owner('addon', 2));
  current.contribute(contribution('addon.panel', { data: '新代' }));
  old.dispose();
  assert.throws(() => old.update(contribution('addon.panel')), /撤销/);
  assert.equal(current.list(point)[0]?.provider.generation, 2);
  assert.equal(current.list(point)[0]?.data, '新代');
  registry.dispose();
});

test('目录快照引用稳定并隔离输入数据，本地 payload 不进入序列化目录', () => {
  const registry = createPointRegistry();
  const access = registry.access(owner('addon'));
  const data = { title: '原值' };
  const payload = () => '本地组件';
  access.contribute(contribution('addon.panel', { data, payload }));
  const first = access.catalog();
  assert.equal(access.catalog(), first);
  data.title = '外部改动';
  assert.deepEqual(access.list(point)[0]?.data, { title: '原值' });
  assert.equal(access.list(point)[0]?.payload, payload);
  assert.equal(JSON.stringify(first).includes('payload'), false);
  assert.equal(Object.isFrozen(first.contributions[0]?.data), true);
  registry.dispose();
});

test('挂载子作用域的写入和订阅随其自身撤销，根插件资源继续存在', () => {
  const registry = createPointRegistry();
  const access = registry.access(owner('addon'));
  access.contribute(contribution('addon.root'));
  const controller = new AbortController();
  const scoped = scopedPointAccess(access, controller.signal, (release) => release);
  assert.ok(scoped);
  scoped.contribute(contribution('addon.child'));
  let observations = 0;
  scoped.subscribe(() => { observations += 1; });
  controller.abort();
  const observedAtClose = observations;
  assert.deepEqual(access.list(point).map((entry) => entry.id), ['addon.root']);
  access.contribute(contribution('addon.next'));
  assert.equal(observations, observedAtClose);
  assert.throws(() => scoped.catalog(), /撤销/);
  registry.dispose();
});

test('错误订阅者不阻断其他观察者或所有权回收', () => {
  const registry = createPointRegistry();
  const addon = owner('addon');
  const access = registry.access(addon);
  let observed = 0;
  access.subscribe(() => { throw new Error('订阅方异常'); });
  registry.access(owner('observer')).subscribe(() => { observed += 1; });
  access.contribute(contribution('addon.panel'));
  addon.close();
  assert.equal(observed, 2);
  registry.dispose();
});

test('信号中止经过原有 track 句柄，注册表销毁同时移除信号监听', () => {
  const registry = createPointRegistry();
  const controller = new AbortController();
  let released = 0;
  const access = registry.access({ pluginId: 'addon', generation: 1, signal: controller.signal,
    track: (cleanup) => () => { released += 1; return cleanup(); },
  });
  access.contribute(contribution('addon.first'));
  access.subscribe(() => {});
  assert.equal(getEventListeners(controller.signal, 'abort').length, 2);
  controller.abort();
  assert.equal(released, 2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const next = owner('next');
  registry.access(next).contribute(contribution('next.panel'));
  assert.equal(getEventListeners(next.signal, 'abort').length, 1);
  registry.dispose();
  assert.equal(getEventListeners(next.signal, 'abort').length, 0);
});

test('结构或 JSON 更新失败不替换现有贡献，Schema 为 false 不会变成允许任意数据', () => {
  const registry = createPointRegistry();
  const access = registry.access(owner('workbench'));
  access.define({ ...point, title: '拒绝数据', inputSchema: false });
  const handle = access.contribute(contribution('workbench.panel'));
  assert.equal(access.list(point)[0]?.reason, 'data_invalid');
  assert.throws(() => handle.update(contribution('workbench.panel', { data: Number.POSITIVE_INFINITY })), /JSON/);
  assert.deepEqual(access.list(point)[0]?.data, { title: '测试' });
  registry.dispose();
});
