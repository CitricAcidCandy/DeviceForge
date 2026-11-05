import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { TaskHistoryChange } from '../src/plugin-sdk/index.ts';
import { createApiClient } from '../src/services/api/index.ts';
import { createTasks, createTaskListRefresh } from '../src/features/tasks/index.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const ready: TaskHistoryChange = { state: 'ready', revision: '1', reset: true };
function unexpectedErrors(context: TestContext) {
  const errors: unknown[] = [];
  context.after(() => assert.deepEqual(errors, [], '成功场景不应产生被观察者隔离吞掉的错误'));
  return (error: unknown) => { errors.push(error); };
}
function changes() {
  const listeners = new Set<(change: TaskHistoryChange) => void>();
  let subscribed = 0, released = 0;
  return {
    subscribeChanges(listener: (change: TaskHistoryChange) => void) {
      subscribed++;
      listeners.add(listener);
      listener(ready);
      return () => { released++; listeners.delete(listener); };
    },
    emit(change: TaskHistoryChange) { for (const listener of [...listeners]) listener(change); },
    counts: () => ({ subscribed, released, listeners: listeners.size }),
  };
}

test('任务刷新先订阅再快照，同步 ready 和重复 start 不重复读取，健康空闲一分钟不轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const source = changes(), order: string[] = [];
  const model = createTaskListRefresh({ intervalMs: 5_000,
    subscribeChanges: (listener) => { order.push('subscribe'); return source.subscribeChanges(listener); },
    read: async () => { order.push('list'); }, onError: unexpectedErrors(t),
  });
  t.after(() => model.dispose());
  model.start(); model.start();
  await flush();
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(order, ['subscribe', 'list']);
  assert.equal(source.counts().subscribed, 1);
});

test('任务刷新在途 changed 合并补读，不取消当前请求且不丢最后变化', async (t) => {
  const source = changes();
  let finish: () => void = () => undefined;
  let calls = 0;
  const signals: AbortSignal[] = [];
  const model = createTaskListRefresh({ intervalMs: 5_000, subscribeChanges: source.subscribeChanges,
    read: async (signal) => {
      signals.push(signal);
      if (++calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
    }, onError: unexpectedErrors(t),
  });
  t.after(() => model.dispose());
  model.start(); await flush();
  source.emit({ state: 'changed', revision: '2', reset: false });
  source.emit({ state: 'changed', revision: '3', reset: false });
  assert.equal(calls, 1); assert.equal(signals[0]?.aborted, false);
  finish(); await flush();
  assert.equal(calls, 2);
  source.emit({ state: 'changed', revision: '4', reset: false }); await flush();
  assert.equal(calls, 3);
});

test('旧宿主缺订阅时按原间隔降级，历史读取失败不永久停止独立刷新', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let calls = 0, errors = 0;
  const model = createTaskListRefresh({ intervalMs: 15_000,
    read: async () => { if (++calls === 1) throw new Error('临时失败'); }, onError: () => { errors++; },
  });
  t.after(() => model.dispose());
  model.start(); await flush();
  t.mock.timers.tick(15_000); await flush();
  assert.equal(calls, 2); assert.equal(errors, 1);
  model.setIntervalMs(5_000);
  t.mock.timers.tick(5_000); await flush();
  assert.equal(calls, 3);
});

test('任务通知断线恢复先读快照，恢复后取消 HTTP 降级定时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const source = changes(); let calls = 0;
  const model = createTaskListRefresh({ intervalMs: 5_000, subscribeChanges: source.subscribeChanges,
    read: async () => { calls++; }, onError: unexpectedErrors(t),
  });
  t.after(() => model.dispose());
  model.start(); await flush();
  source.emit({ state: 'unavailable', revision: '1', reset: false });
  t.mock.timers.tick(5_000); await flush(); assert.equal(calls, 2);
  source.emit({ state: 'ready', revision: '9', reset: true }); await flush();
  assert.equal(calls, 3);
  t.mock.timers.tick(60_000); await flush(); assert.equal(calls, 3);
});

test('任务刷新释放请求、期限、降级定时器和订阅，晚通知不复活实例', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const source = changes(); let calls = 0, aborted = false;
  const model = createTaskListRefresh({ intervalMs: 5_000, subscribeChanges: source.subscribeChanges,
    read: async (signal) => {
      calls++;
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await new Promise(() => undefined);
    }, onError: unexpectedErrors(t),
  });
  model.start(); await flush();
  source.emit({ state: 'changed', revision: '2', reset: false });
  model.dispose(); model.dispose();
  await flush();
  source.emit(ready); model.start(); await model.refresh();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(calls, 1); assert.equal(aborted, true);
  assert.deepEqual(source.counts(), { subscribed: 1, released: 1, listeners: 0 });
});

test('任务刷新超时结束忽略取消的读取，后续独立刷新仍可成功', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let calls = 0, errors = 0;
  const model = createTaskListRefresh({ intervalMs: 5_000, timeoutMs: 1_000,
    read: async () => { if (++calls === 1) await new Promise(() => undefined); },
    onError: () => { errors++; },
  });
  t.after(() => model.dispose());
  model.start(); await flush();
  t.mock.timers.tick(1_000); await flush();
  await model.refresh();
  assert.equal(errors, 1); assert.equal(calls, 2);
});

test('注入的任务端口兼容旧调用，隔离抛错订阅者并在 dispose 时全部释放', () => {
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => { throw new Error('不应创建请求'); } });
  const legacy = createTasks(client);
  assert.equal('subscribeChanges' in legacy, false); legacy.dispose();
  const source = changes();
  const tasks = createTasks(client, undefined, { subscribeChanges: source.subscribeChanges });
  let calls = 0;
  tasks.subscribeChanges?.(() => { throw new Error('单个消费者错误'); });
  const release = tasks.subscribeChanges?.(() => { calls++; });
  source.emit({ state: 'changed', revision: '2', reset: false });
  assert.equal(calls, 2);
  void release?.();
  source.emit(ready); assert.equal(calls, 2);
  tasks.dispose(); tasks.dispose();
  tasks.subscribeChanges?.(() => { throw new Error('已关闭不得通知'); });
  assert.deepEqual(source.counts(), { subscribed: 2, released: 2, listeners: 0 });
});

test('任务订阅初始化抛错只使当前消费者降级，不影响后续快照读取', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let calls = 0, errors = 0;
  const model = createTaskListRefresh({ intervalMs: 5_000,
    subscribeChanges: () => { throw new Error('当前通知不可用'); },
    read: async () => { calls++; }, onError: () => { errors++; },
  });
  t.after(() => model.dispose());
  model.start(); await flush();
  t.mock.timers.tick(5_000); await flush();
  assert.equal(calls, 2); assert.equal(errors, 1);
});

test('ready 后快照读取失败仍按原节奏补读，成功同步后才停止降级轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const source = changes(); let calls = 0, errors = 0;
  const model = createTaskListRefresh({ intervalMs: 5_000, subscribeChanges: source.subscribeChanges,
    read: async () => { if (++calls === 1) throw new Error('快照尚未恢复'); }, onError: () => { errors++; },
  });
  t.after(() => model.dispose());
  model.start(); await flush();
  t.mock.timers.tick(5_000); await flush();
  assert.equal(calls, 2); assert.equal(errors, 1);
  t.mock.timers.tick(60_000); await flush(); assert.equal(calls, 2);
});
