import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../browser/src/index.js';

test('可选数据入口缺席时插件仍能激活', async () => {
  await plugin.activate({ signal: new AbortController().signal });
});

test('示例数据源独立读写、原子修订校验和无别名快照', async () => {
  let source;
  let releases = 0;
  const release = () => { releases++; };
  const context = { signal: new AbortController().signal,
    debug: { registerDataSource(definition) { source = definition; return release; } },
    onDispose(callback) { assert.equal(callback, release); callback(); },
  };
  await plugin.activate(context);
  assert.equal(releases, 1);
  assert.equal(source.persistence, 'memory');
  const signal = new AbortController().signal;
  const first = await source.read(null, signal);
  first.value.count = 99;
  assert.equal((await source.read(null, signal)).value.count, 0);
  const request = { expectedRevision: first.revision, value: { name: '新名称', count: 2 } };
  await source.write(request, signal);
  await assert.rejects(source.write(request, signal), /修订冲突/);
  assert.deepEqual(await source.read(null, signal), { revision: '2', value: request.value });
  await assert.rejects(source.write({ expectedRevision: '2', value: { name: '无效', count: -1 } }, signal));
  await assert.rejects(source.read(null, AbortSignal.abort()));
});
