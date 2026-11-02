import test from 'node:test';
import assert from 'node:assert/strict';
import { createLazyProductResources } from '../src/app/product/lazy-resources.ts';

test('兼容业务仅在首次读取时创建，重复读取复用且未使用业务不参与清理', async () => {
  const owner = createLazyProductResources();
  const constructed: string[] = [], released: string[] = [];
  const first = owner.lazy('first', () => { constructed.push('first'); return { draft: '' }; }, () => { released.push('first'); });
  owner.lazy('unused', () => { constructed.push('unused'); return {}; }, () => { released.push('unused'); });
  assert.deepEqual(owner.snapshot(), []);
  assert.deepEqual(constructed, []);
  const value = first(); value.draft = '保留草稿';
  assert.equal(first(), value);
  assert.equal(first().draft, '保留草稿');
  assert.deepEqual(constructed, ['first']);
  assert.deepEqual(owner.snapshot(), ['first']);
  const closing = owner.dispose();
  assert.deepEqual(released, ['first'], '应在外层运行时取消前同步发起清理');
  assert.equal(owner.dispose(), closing);
  await closing;
  assert.throws(first, /已关闭/);
});

test('单个兼容业务释放失败不跳过其他资源，保留清理错误', async () => {
  const owner = createLazyProductResources(), released: string[] = [];
  const bad = owner.lazy('bad', () => ({}), () => { released.push('bad'); throw new Error('原有释放失败'); });
  const good = owner.lazy('good', () => ({}), async () => { released.push('good'); });
  bad(); good();
  await assert.rejects(owner.dispose(), (error) => error instanceof AggregateError && error.errors.length === 1);
  assert.deepEqual(released.sort(), ['bad', 'good']);
});

test('兼容资源忽略清理返回时有界结束，晚到结果不能重新开放工厂', async () => {
  const owner = createLazyProductResources(10);
  const read = owner.lazy('stuck', () => ({}), () => new Promise<void>(() => {}));
  read();
  await assert.rejects(owner.dispose(), (error) => error instanceof AggregateError);
  assert.throws(read, /已关闭/);
});

test('关闭未使用的兼容层不运行任何工厂，关闭后也不能新建资源', async () => {
  const owner = createLazyProductResources();
  let created = 0;
  const read = owner.lazy('late', () => ++created, () => {});
  await owner.dispose();
  assert.equal(created, 0);
  assert.throws(read, /已关闭/);
  assert.throws(() => owner.lazy('new', () => 1, () => {}), /已关闭/);
});
