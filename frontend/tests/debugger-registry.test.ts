import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugOwner } from '../src/plugin-sdk/debug.ts';
import type { Dispose } from '../src/plugin-sdk/models.ts';
import { createDebugRegistry, scopedDebugAccess } from '../src/plugins/debugger/index.ts';
import { copyMetadata } from '../src/plugins/debugger/json.ts';

const owner: DebugOwner = { pluginId: 'demo', generation: 7 };
function lifetime() {
  const controller = new AbortController();
  const stack: Dispose[] = [];
  const track = (dispose: Dispose): Dispose => {
    let task: Promise<void> | undefined;
    const release = () => { task ??= Promise.resolve().then(dispose); return task; };
    stack.push(release); return release;
  };
  return { controller, track, async close() { controller.abort(); for (const release of stack.reverse()) await release(); } };
}

test('语义登记保持稳定修订，重登记递增节点代次并拒绝旧句柄', async () => {
  const scope = lifetime();
  const registry = createDebugRegistry(owner, scope.controller.signal, scope.track);
  const first = registry.debug.registerNode({ id: 'page', role: 'page', label: '任务' });
  const before = registry.snapshot();
  first.update({ role: 'page', label: '任务' });
  assert.equal(registry.snapshot().revision, before.revision);
  first.update({ role: 'page', label: '任务列表', metadata: { count: 3 } });
  assert.equal(registry.snapshot().nodes[0]?.revision, 2);
  await first.dispose();
  const replacement = registry.debug.registerNode({ id: 'page', role: 'page', label: '新任务' });
  assert.ok(replacement.generation > first.generation);
  assert.throws(() => first.update({ role: 'page', label: '旧任务' }), /旧代/);
  await scope.close();
  assert.throws(() => registry.debug.emit({ name: 'late' }), /撤销/);
  assert.equal(registry.snapshot().disposed, true);
});

test('父子语义节点拒绝循环，父撤销后子节点不保留悬空引用', async () => {
  const scope = lifetime();
  const registry = createDebugRegistry(owner, scope.controller.signal, scope.track);
  const parent = registry.debug.registerNode({ id: 'a', role: 'region', label: '父' });
  registry.debug.registerNode({ id: 'b', parentId: 'a', role: 'region', label: '子' });
  assert.throws(() => parent.update({ parentId: 'b', role: 'region', label: '父' }), /循环/);
  await parent.dispose();
  assert.equal(registry.snapshot().nodes[0]?.parentId, null);
  await scope.close();
});

test('元数据拒绝非JSON、getter、循环、敏感字段且不调用getter', () => {
  let reads = 0;
  assert.throws(() => copyMetadata({ get count() { reads++; return 1; } }), /访问器/);
  assert.equal(reads, 0);
  for (const value of [{ x: NaN }, { x: undefined }, { x: () => 1 }, { token: 'not-a-real-secret' }, { x: new Date() }])
    assert.throws(() => copyMetadata(value));
  const cyclic = new Map<string, unknown>(); cyclic.set('self', cyclic);
  assert.throws(() => copyMetadata({ cyclic }));
  assert.deepEqual(copyMetadata({ phase: 'ready', count: 1, flags: [true, null] }), { phase: 'ready', count: 1, flags: [true, null] });
});

test('事件保持结构化、只收主动元数据并限制500条', async () => {
  const scope = lifetime();
  const registry = createDebugRegistry(owner, scope.controller.signal, scope.track);
  const metadata = { count: 1 };
  registry.debug.emit({ name: 'ready', metadata });
  metadata.count = 9;
  assert.equal(registry.snapshot().events[0]?.metadata['count'], 1);
  for (let i = 0; i < 505; i++) registry.debug.emit({ name: 'phase', metadata: { index: i } });
  const snapshot = registry.snapshot();
  assert.equal(snapshot.events.length, 500); assert.equal(snapshot.droppedEvents, 6);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  assert.ok(Object.isFrozen(snapshot.events));
  await scope.close();
});

test('子作用域关闭只撤销本作用域节点资源，父与兄弟继续登记', async () => {
  const parent = lifetime(), child = lifetime(), sibling = lifetime();
  const registry = createDebugRegistry(owner, parent.controller.signal, parent.track);
  const access = scopedDebugAccess(registry.debug, child.controller.signal, child.track);
  const other = scopedDebugAccess(registry.debug, sibling.controller.signal, sibling.track);
  const handle = access.registerNode({ id: 'child', role: 'panel', label: '子面板' });
  other.registerNode({ id: 'other', role: 'panel', label: '兄弟面板' });
  let releases = 0;
  access.registerResource({ id: 'timer', kind: 'timer', label: '定时器' }, () => { releases++; });
  await child.close();
  assert.equal(releases, 1);
  assert.deepEqual(registry.snapshot().nodes.map((node) => node.id), ['other']);
  assert.throws(() => handle.update({ role: 'panel', label: '迟到' }), /撤销/);
  assert.throws(() => access.emit({ name: 'late' }), /撤销/);
  other.emit({ name: 'alive', nodeId: 'other' });
  assert.equal(registry.snapshot().disposed, false);
  assert.equal(scopedDebugAccess(undefined, child.controller.signal, child.track), undefined);
  await sibling.close(); await parent.close();
});

test('父级dispose逆序释放、保留失败且不跳过其他资源', async () => {
  const controller = new AbortController();
  const registry = createDebugRegistry(owner, controller.signal, (dispose) => dispose);
  const order: string[] = [];
  registry.debug.registerResource({ id: 'a', kind: 'subscription', label: '订阅' }, () => { order.push('a'); });
  registry.debug.registerResource({ id: 'b', kind: 'timer', label: '定时器' }, () => { order.push('b'); throw new Error('合成失败'); });
  await assert.rejects(registry.dispose(), AggregateError);
  assert.deepEqual(order, ['b', 'a']);
  assert.deepEqual(registry.snapshot().resources.map((item) => item.state), ['released', 'release_failed']);
  await assert.rejects(registry.dispose(), AggregateError);
  assert.deepEqual(order, ['b', 'a']);
});

test('永不返回的释放有界收敛，并保留真实资源状态未知', async () => {
  const controller = new AbortController();
  const registry = createDebugRegistry(owner, controller.signal, (dispose) => dispose);
  registry.debug.registerResource({ id: 'stuck', kind: 'custom', label: '不返回' }, () => new Promise<void>(() => {}));
  await assert.rejects(registry.dispose(), AggregateError);
  assert.equal(registry.snapshot().resources[0]?.state, 'release_failed');
});

test('已撤销父信号不允许新登记，资源显式释放保持幂等', async () => {
  const controller = new AbortController(); controller.abort();
  const registry = createDebugRegistry(owner, controller.signal, (dispose) => dispose);
  assert.throws(() => registry.debug.registerNode({ id: 'a', role: 'page', label: '页' }), /撤销/);
  await registry.dispose();
  const active = createDebugRegistry(owner, new AbortController().signal, (dispose) => dispose);
  let count = 0;
  const release = active.debug.registerResource({ id: 'a', kind: 'custom', label: '资源' }, () => { count++; });
  await release(); await release(); await active.dispose();
  assert.equal(count, 1);
});
