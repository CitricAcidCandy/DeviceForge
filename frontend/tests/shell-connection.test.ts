import assert from 'node:assert/strict';
import test from 'node:test';
import { createShellConnection } from '../plugins/default-shell/src/connection.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import { HostError } from '../src/plugin-sdk/models.ts';
import { deferred } from './fixtures.ts';

function host(listOperations: HostContext['listOperations']): HostContext {
  const unavailable = async (): Promise<never> => { throw new Error('连接单元不执行业务'); };
  return {
    apiVersion: 2, signal: new AbortController().signal, listOperations,
    submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    subscribeOperations: () => () => {}, onDispose: (release) => release,
  };
}

test('外壳只在公开目录实际返回后显示已连接，并合并同一次在途刷新', async () => {
  const result = deferred<Awaited<ReturnType<HostContext['listOperations']>>>();
  let reads = 0;
  const model = createShellConnection(host(async () => { reads++; return result.promise; }));
  try {
    assert.equal(model.snapshot().state, 'waiting');
    const first = model.refresh(), second = model.refresh();
    assert.equal(first, second);
    assert.equal(model.snapshot().state, 'connecting');
    await Promise.resolve();
    assert.equal(reads, 1);
    result.resolve({ data: [], logId: 'connection-log' });
    await first;
    assert.equal(model.snapshot().state, 'connected');
    assert.equal(model.snapshot().logId, 'connection-log');
  } finally { model.dispose(); }
});

test('连接失败保留真实日志并允许独立重连，不以本地插件挂载冒充在线', async () => {
  let calls = 0;
  const model = createShellConnection(host(async () => {
    if (++calls === 1) throw new HostError('network', 'offline', '连接已断开', 'offline-log');
    return { data: [], logId: 'reconnect-log' };
  }));
  try {
    await model.refresh();
    assert.equal(model.snapshot().state, 'failed');
    assert.equal(model.snapshot().logId, 'offline-log');
    await model.refresh();
    assert.equal(model.snapshot().state, 'connected');
    assert.equal(calls, 2);
  } finally { model.dispose(); }
});

test('外壳释放有界结束忽略取消的等待，晚到目录不能发布到旧作用域', async () => {
  const result = deferred<Awaited<ReturnType<HostContext['listOperations']>>>();
  const model = createShellConnection(host(async () => result.promise));
  let notifications = 0;
  model.subscribe(() => { notifications++; });
  const pending = model.refresh();
  await Promise.resolve();
  model.dispose();
  await pending;
  const before = notifications;
  result.resolve({ data: [], logId: 'late' });
  await Promise.resolve();
  assert.equal(notifications, before);
  assert.notEqual(model.snapshot().state, 'connected');
});
