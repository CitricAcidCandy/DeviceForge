import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { Dispose, HistoricalJob, HostContext, TaskHistoryAccess, TaskHistoryChange } from '../src/plugin-sdk/index.ts';
import { createPluginScope } from '../src/plugins/scope.ts';

const { createTaskFooterModel } = await import('../plugins/tasks/src/footer-model.ts');

const ready: TaskHistoryChange = { state: 'ready', revision: '1', reset: true };
const changed: TaskHistoryChange = { state: 'changed', revision: '2', reset: false };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const historical: HistoricalJob = { id: 'history', operation: 'sample.read', status: 'succeeded',
  input: null, result: null, error: null, createdAt: 1 };

function host(history?: TaskHistoryAccess, signal = new AbortController().signal): HostContext {
  return {
    apiVersion: 2, signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('不提交业务任务'); },
    getJob: async () => { throw new Error('不读取普通任务端口'); },
    cancelJob: async () => { throw new Error('不取消业务任务'); },
    subscribeOperations: () => () => {}, onDispose: () => () => {},
    ...(history ? { taskHistory: history } : {}),
  };
}

function source(initial?: TaskHistoryChange, onRelease?: Dispose) {
  const listeners = new Set<(change: TaskHistoryChange) => void>();
  const saved: ((change: TaskHistoryChange) => void)[] = [];
  let subscribed = 0, released = 0, listed = 0;
  const history: TaskHistoryAccess = {
    list: async () => { listed++; return { data: [], logId: 'history-log' }; },
    get: async () => ({ data: historical, logId: 'history-log' }),
    events: async () => ({ data: [], logId: 'events-log' }),
    subscribeChanges(listener) {
      assert.equal(this, history);
      subscribed++; listeners.add(listener); saved.push(listener);
      if (initial) listener(initial);
      return () => { released++; listeners.delete(listener); return onRelease?.(); };
    },
  };
  return {
    history,
    emit(change: TaskHistoryChange) { for (const listener of [...listeners]) listener(change); },
    late(index: number) { const listener = saved[index]; assert.ok(listener); listener(changed); },
    counts: () => ({ subscribed, released, listed, listeners: listeners.size }),
  };
}

function subscribe(history: TaskHistoryAccess | undefined) {
  assert.ok(history);
  const result = history.subscribeChanges;
  assert.ok(result);
  return result;
}

test('可选订阅只在宿主提供时透传，原历史读取保留参数、日志与作用域信号', async () => {
  const missing = createPluginScope(host());
  const observed: { kind: string; input: unknown; signal: AbortSignal }[] = [];
  const legacy: TaskHistoryAccess = {
    list: async (query, signal) => { observed.push({ kind: 'list', input: query, signal }); return { data: [historical], logId: 'list-log' }; },
    get: async (id, signal) => { observed.push({ kind: 'get', input: id, signal }); return { data: historical, logId: 'get-log' }; },
    events: async (id, query, signal) => { observed.push({ kind: 'events', input: { id, ...query }, signal }); return { data: [], logId: 'events-log' }; },
  };
  const scope = createPluginScope(host(legacy));
  const caller = new AbortController();
  try {
    assert.equal('taskHistory' in missing.context, false);
    const history = scope.context.taskHistory; assert.ok(history);
    assert.equal('subscribeChanges' in history, false);
    assert.deepEqual(await history.list({ limit: 2 }, caller.signal), { data: [historical], logId: 'list-log' });
    assert.equal((await history.get('history', caller.signal)).logId, 'get-log');
    assert.equal((await history.events('history', { after: 1 }, caller.signal)).logId, 'events-log');
    assert.deepEqual(observed.map(({ kind, input }) => ({ kind, input })), [
      { kind: 'list', input: { limit: 2 } }, { kind: 'get', input: 'history' },
      { kind: 'events', input: { id: 'history', after: 1 } },
    ]);
    assert.equal(observed.every((item) => item.signal !== caller.signal && !item.signal.aborted), true);
    scope.close();
    assert.equal(observed.every((item) => item.signal.aborted), true);
    await assert.rejects(history.list({}, caller.signal), (error: unknown) => error instanceof HostError && error.code === 'plugin_unloaded');
  } finally { await scope.dispose(); await missing.dispose(); }
});

test('官方任务模型经过真实插件作用域后仍订阅，健康空闲一分钟没有列表轮询', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const upstream = source(ready), scope = createPluginScope(host(upstream.history));
  const model = createTaskFooterModel(scope.context);
  try {
    model.start(); await flush();
    assert.deepEqual(upstream.counts(), { subscribed: 1, released: 0, listed: 1, listeners: 1 });
    context.mock.timers.tick(60_000); await flush();
    assert.equal(upstream.counts().listed, 1);
    upstream.emit(changed); await flush();
    assert.equal(upstream.counts().listed, 2);
    scope.close();
    context.mock.timers.tick(60_000); await flush();
    assert.deepEqual(upstream.counts(), { subscribed: 1, released: 1, listed: 2, listeners: 0 });
  } finally { model.dispose(); await scope.dispose(); }
});

test('同作用域消费者分别释放且句柄幂等，晚通知不能恢复手动释放的订阅', async () => {
  const upstream = source(), scope = createPluginScope(host(upstream.history));
  let first = 0, second = 0;
  try {
    const listen = subscribe(scope.context.taskHistory);
    const releaseFirst = listen(() => { first++; });
    const releaseSecond = listen(() => { second++; });
    upstream.emit(ready);
    await releaseFirst(); await releaseFirst();
    upstream.late(0); upstream.emit(changed);
    assert.equal(first, 1); assert.equal(second, 2);
    assert.equal(upstream.counts().released, 1);
    await releaseSecond(); await scope.dispose();
    assert.equal(upstream.counts().released, 2);
    assert.equal(upstream.counts().listeners, 0);
  } finally { await scope.dispose(); }
});

test('消费者同步抛错不影响订阅登记、其他消费者或后续通知', async () => {
  const upstream = source(ready), scope = createPluginScope(host(upstream.history));
  let calls = 0;
  try {
    const listen = subscribe(scope.context.taskHistory);
    assert.doesNotThrow(() => listen(() => { throw new Error('单个观察者错误'); }));
    listen(() => { calls++; });
    assert.doesNotThrow(() => upstream.emit(changed));
    assert.equal(calls, 2);
    assert.equal(upstream.counts().listeners, 2);
  } finally { await scope.dispose(); }
  assert.equal(upstream.counts().released, 2);
});

test('兄弟作用域独立，旧引用和旧回调不能因新作用域建立而复活', async () => {
  const upstream = source();
  const first = createPluginScope(host(upstream.history)), second = createPluginScope(host(upstream.history));
  let oldCalls = 0, siblingCalls = 0, newCalls = 0;
  const stale = subscribe(first.context.taskHistory);
  stale(() => { oldCalls++; });
  subscribe(second.context.taskHistory)(() => { siblingCalls++; });
  upstream.emit(ready);
  await first.dispose();
  const replacement = createPluginScope(host(upstream.history));
  try {
    subscribe(replacement.context.taskHistory)(() => { newCalls++; });
    assert.throws(() => stale(() => { oldCalls++; }),
      (error: unknown) => error instanceof HostError && error.code === 'plugin_unloaded');
    upstream.late(0); upstream.emit(changed);
    assert.equal(oldCalls, 1); assert.equal(siblingCalls, 2); assert.equal(newCalls, 1);
    assert.equal(upstream.counts().subscribed, 3);
    assert.equal(upstream.counts().listeners, 2);
  } finally { await replacement.dispose(); await second.dispose(); await first.dispose(); }
  assert.equal(upstream.counts().released, 3);
});

test('父signal撤销会回收作用域订阅，旧端口不能再次登记', async () => {
  const lifetime = new AbortController(), upstream = source();
  const scope = createPluginScope(host(upstream.history, lifetime.signal));
  let calls = 0;
  const listen = subscribe(scope.context.taskHistory);
  listen(() => { calls++; });
  lifetime.abort();
  try {
    assert.equal(scope.context.signal.aborted, true);
    assert.equal(upstream.counts().released, 1);
    upstream.late(0); upstream.emit(ready);
    assert.equal(calls, 0);
    assert.throws(() => listen(() => { calls++; }),
      (error: unknown) => error instanceof HostError && error.code === 'plugin_unloaded');
    assert.equal(upstream.counts().subscribed, 1);
  } finally { await scope.dispose(); }
});

test('同步初始通知关闭scope或父signal时，仍立即释放刚返回的上游句柄', async () => {
  for (const parentAbort of [false, true]) {
    const lifetime = new AbortController(), upstream = source(ready);
    const scope = createPluginScope(host(upstream.history, lifetime.signal));
    let calls = 0;
    try {
      const release = subscribe(scope.context.taskHistory)(() => {
        calls++;
        if (parentAbort) lifetime.abort();
        else scope.close();
      });
      assert.equal(calls, 1);
      assert.deepEqual(upstream.counts(), { subscribed: 1, released: 1, listed: 0, listeners: 0 });
      upstream.late(0); upstream.emit(changed);
      await release(); await release();
      assert.equal(calls, 1); assert.equal(upstream.counts().released, 1);
    } finally { await scope.dispose(); }
  }
});

test('同步通知内dispose仍通过track等待晚取得句柄的异步回收', async () => {
  let finish: () => void = () => {};
  const returning = new Promise<void>((resolve) => { finish = resolve; });
  const upstream = source(ready, () => returning);
  const scope = createPluginScope(host(upstream.history));
  const observation: { draining?: Promise<void>; settled: boolean } = { settled: false };
  try {
    subscribe(scope.context.taskHistory)(() => {
      observation.draining = scope.dispose();
      void observation.draining.then(() => { observation.settled = true; });
    });
    assert.ok(observation.draining);
    assert.equal(upstream.counts().released, 1);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(observation.settled, false);
    finish(); await observation.draining;
    assert.equal(observation.settled, true);
    assert.equal(upstream.counts().listeners, 0);
  } finally { finish(); await scope.dispose(); }
});

test('上游订阅登记抛错不阻止历史读取或后续独立登记', async () => {
  const upstream = source(ready), original = upstream.history.subscribeChanges;
  assert.ok(original);
  let rejectRegistration = true;
  const scope = createPluginScope(host({ ...upstream.history,
    subscribeChanges(listener) {
      if (rejectRegistration) throw new Error('本次登记失败');
      return original.call(upstream.history, listener);
    },
  }));
  try {
    const listen = subscribe(scope.context.taskHistory);
    assert.throws(() => listen(() => {}), /本次登记失败/);
    const history = scope.context.taskHistory; assert.ok(history);
    assert.equal((await history.list({}, new AbortController().signal)).logId, 'history-log');
    rejectRegistration = false;
    let calls = 0;
    listen(() => { calls++; }); upstream.emit(changed);
    assert.equal(calls, 2);
    assert.equal(upstream.counts().subscribed, 1);
  } finally { await scope.dispose(); }
  assert.equal(upstream.counts().released, 1);
});
