import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { HostContext, TaskHistoryAccess, TaskHistoryChange } from '@deviceforge/plugin-sdk';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@deviceforge/plugin-sdk'
      ? { url: new URL('../../../src/plugin-sdk/index.ts', import.meta.url).href, shortCircuit: true }
      : next(specifier, context);
  },
});
const { createTasksModel } = await import('../src/model/index.ts');
function fixture(subscribeChanges?: NonNullable<TaskHistoryAccess['subscribeChanges']>) {
  const controller = new AbortController();
  let lists = 0;
  const unused = async (): Promise<never> => { throw new Error('不应调用其他业务端口'); };
  const context: HostContext = {
    apiVersion: 2, signal: controller.signal, onDispose: (release) => release,
    listOperations: unused, subscribeOperations: () => () => undefined,
    submit: unused, getJob: unused, cancelJob: unused,
    taskHistory: {
      list: async () => { lists++; return { data: [], logId: 'list-log' }; },
      get: unused, events: unused,
      ...(subscribeChanges ? { subscribeChanges } : {}),
    },
  };
  return { context, controller, lists: () => lists };
}

test('任务页模型保留旧宿主契约，未订阅时不读取和创建连接', async () => {
  const value = fixture();
  const model = createTasksModel(value.context);
  assert.equal('subscribeChanges' in model, false);
  assert.equal(value.lists(), 0);
  assert.equal((await model.list({}, new AbortController().signal)).logId, 'list-log');
  model.dispose();
});

test('任务页模型转发可选通知，隔离消费者抛错并随实例结束释放所有订阅', () => {
  const listeners = new Set<(change: TaskHistoryChange) => void>();
  let releases = 0;
  const value = fixture((listener) => {
    listeners.add(listener);
    listener({ state: 'ready', revision: '1', reset: true });
    return () => { releases++; listeners.delete(listener); };
  });
  const model = createTasksModel(value.context);
  let notices = 0;
  model.subscribeChanges?.(() => { throw new Error('单个视图错误'); });
  const stop = model.subscribeChanges?.(() => { notices++; });
  for (const listener of listeners) listener({ state: 'changed', revision: '2', reset: false });
  assert.equal(notices, 2); assert.equal(value.lists(), 0);
  void stop?.();
  value.controller.abort(); model.dispose();
  model.subscribeChanges?.(() => { notices++; });
  assert.equal(releases, 2); assert.equal(listeners.size, 0); assert.equal(notices, 2);
});

test('任务页模型初始化通知同步销毁时仍释放刚返回的句柄', () => {
  let releases = 0;
  const value = fixture((listener) => {
    listener({ state: 'ready', revision: '1', reset: true });
    return () => { releases++; };
  });
  const model = createTasksModel(value.context);
  model.subscribeChanges?.(() => model.dispose());
  assert.equal(releases, 1);
});

test('任务页模型订阅端口抛错返回 unavailable，独立历史查询仍可继续', async () => {
  const value = fixture(() => { throw new Error('通知初始化失败'); });
  const model = createTasksModel(value.context);
  const seen: TaskHistoryChange[] = [];
  model.subscribeChanges?.((change) => { seen.push(change); });
  assert.deepEqual(seen, [{ state: 'unavailable', revision: null, reset: true }]);
  await model.list({}, new AbortController().signal);
  assert.equal(value.lists(), 1);
  model.dispose();
});
