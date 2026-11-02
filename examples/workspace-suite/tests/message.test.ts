import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageStore } from '../browser/domain/message.ts';

test('CAS保存原子比较修订，冲突保留调用者草稿且不覆盖已保存值', () => {
  const store = createMessageStore('first-load', new AbortController().signal);
  const original = store.read(), draft = { message: '我编辑的草稿' };
  const saved = store.write({ value: { message: '另一编辑者先保存' }, expectedRevision: original.revision });
  assert.throws(() => store.write({ value: draft, expectedRevision: original.revision }),
    (error) => error instanceof Error && 'code' in error && error.code === 'data_source_conflict');
  assert.deepEqual(draft, { message: '我编辑的草稿' });
  assert.deepEqual(store.read(), saved);
});

test('重载生成新的修订命名空间，旧代写入不能覆盖新数据', () => {
  const first = new AbortController(), previous = createMessageStore('load-a', first.signal);
  const revision = previous.read().revision;
  first.abort();
  assert.throws(() => previous.write({ value: { message: '旧结果' }, expectedRevision: revision }));
  const current = createMessageStore('load-b', new AbortController().signal);
  assert.throws(() => current.write({ value: { message: '旧结果' }, expectedRevision: revision }));
  assert.deepEqual(current.read().value, { message: '' });
});

test('读取返回副本，坏输入和已取消写入均不修改当前值', () => {
  const lifetime = new AbortController(), store = createMessageStore('load', lifetime.signal);
  const initial = store.read();
  initial.value.message = '外部篡改';
  assert.deepEqual(store.read().value, { message: '' });
  assert.throws(() => store.write({ value: { message: 'a', extra: true }, expectedRevision: initial.revision }));
  lifetime.abort();
  assert.throws(() => store.write({ value: { message: '取消' }, expectedRevision: initial.revision }));
});
