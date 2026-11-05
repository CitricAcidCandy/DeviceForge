import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Dispose, HistoricalJob, HostContext, HostResult, TaskHistoryAccess, TaskHistoryChange } from '@deviceforge/plugin-sdk';
registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@deviceforge/plugin-sdk'
      ? { url: new URL('../../../src/plugin-sdk/index.ts', import.meta.url).href, shortCircuit: true }
      : next(specifier, context);
  },
});
const { createTaskFooterModel, taskFooterCounts } = await import('../src/footer-model.ts');
const { createTasksPlugin } = await import('../src/index.ts');
const { createWorkspaceRegistry } = await import('../../../src/plugins/workspace/index.ts');
const { createPointRegistry } = await import('../../../src/plugins/points/index.ts');
function job(status: HistoricalJob['status']): HistoricalJob {
  return { id: `job-${status}`, operation: 'plugin.sample.run', status, result: null, error: null, input: {}, createdAt: 1 };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(
  list: (signal: AbortSignal) => Promise<HostResult<readonly HistoricalJob[]>>,
  subscribeChanges?: NonNullable<TaskHistoryAccess['subscribeChanges']>,
) {
  const lifetime = new AbortController();
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, onDispose: (release) => release,
    listOperations: async () => { throw new Error('不应请求操作目录'); }, subscribeOperations: () => () => undefined,
    submit: async () => { throw new Error('不应提交任务'); },
    cancelJob: async () => { throw new Error('不应取消任务'); },
    getJob: async () => { throw new Error('不应查询单个任务'); },
    taskHistory: {
      ...(subscribeChanges ? { subscribeChanges } : {}),
      list: async (query, signal) => { assert.equal(query.limit, 200); return list(signal); },
      get: async () => { throw new Error('不应查询单个任务'); },
      events: async () => { throw new Error('不应请求事件'); },
    },
  };
  return { context, lifetime };
}
test('任务底栏惰性读取最近二百条，只展示真实状态并可显式刷新', async () => {
  let calls = 0;
  const value = fixture(async () => { calls++; return { data: [job('running'), job('queued'), job('failed')], logId: 'log-tasks' }; });
  const model = createTaskFooterModel(value.context);
  assert.equal(calls, 0);
  await model.refresh();
  assert.deepEqual(taskFooterCounts(model.snapshot().jobs), { running: 1, queued: 1, failed: 1 });
  assert.equal(model.snapshot().logId, 'log-tasks'); assert.equal(model.snapshot().error, null);
  await model.refresh(); assert.equal(calls, 2);
  model.dispose();
});
test('任务状态读取失败保留旧观测，超时不把后台任务标成取消', async () => {
  let calls = 0;
  const value = fixture(async () => {
    calls++;
    if (calls === 1) return { data: [job('running')], logId: 'old-log' };
    return new Promise(() => undefined);
  });
  const model = createTaskFooterModel(value.context, { timeoutMs: 8 });
  await model.refresh();
  const timer = setTimeout(() => undefined, 50);
  await model.refresh();
  clearTimeout(timer);
  assert.equal(model.snapshot().jobs[0]?.status, 'running');
  assert.ok(model.snapshot().error);
  assert.equal(model.snapshot().pending, false);
  model.dispose();
});
test('并发刷新合并补读不取消当前请求，卸载不残留刷新', async () => {
  let finish: (value: HostResult<readonly HistoricalJob[]>) => void = () => undefined;
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  const value = fixture(async (signal) => {
    calls++;
    if (calls === 1) { firstSignal = signal; return new Promise((resolve) => { finish = resolve; }); }
    return { data: [job('succeeded')], logId: 'new-log' };
  });
  const model = createTaskFooterModel(value.context, { intervalMs: 10 });
  const first = model.refresh();
  await flush();
  const second = model.refresh();
  assert.equal(calls, 1); assert.equal(firstSignal?.aborted, false);
  finish({ data: [job('running')], logId: 'old-log' });
  await Promise.all([first, second]);
  assert.equal(model.snapshot().logId, 'new-log');
  value.lifetime.abort(); await model.refresh();
  assert.equal(calls, 2);
  model.dispose();
});
test('底栏通过公开视图贡献，外壳稍后出现才变为可用，卸载撤销贡献', async () => {
  const value = fixture(async () => ({ data: [], logId: null }));
  const workspace = createWorkspaceRegistry(), points = createPointRegistry();
  const owner = { pluginId: 'sample_tasks', generation: 1, signal: value.lifetime.signal, track: (release: Dispose) => release };
  const pointAccess = points.access(owner);
  const context: HostContext = { ...value.context, ui: workspace.access(owner),
    extensions: {
      points: pointAccess, catalog: () => ({ components: [], commands: [], modules: [], services: [] }),
      executeCommand: async () => ({ data: null, logId: null }), callService: async () => ({ data: null, logId: null }),
      subscribeEvent: () => () => undefined, emitEvent: () => undefined, getState: () => undefined,
      setState: () => undefined, subscribeState: () => () => undefined,
    },
  };
  await createTasksPlugin({ id: 'sample_tasks', version: '1.0.0' }).activate?.(context);
  const ref = { id: 'deviceforge_shell.footer', version: '1' };
  assert.equal(points.list(ref)[0]?.state, 'waiting');
  assert.deepEqual(points.list(ref)[0]?.data, { pluginId: 'sample_tasks', viewId: 'sample_tasks.footer' });
  const shell = points.access({ pluginId: 'deviceforge_shell', generation: 1, signal: new AbortController().signal, track: (release: Dispose) => release });
  shell.define({ ...ref, title: '底栏', modes: ['append'] });
  assert.equal(points.list(ref)[0]?.state, 'active');
  value.lifetime.abort();
  assert.equal(points.list(ref).length, 0);
  workspace.dispose(); points.dispose();
});

function notifications() {
  const listeners = new Set<(change: TaskHistoryChange) => void>();
  let starts = 0, stops = 0;
  return {
    subscribeChanges(listener: (change: TaskHistoryChange) => void) {
      starts++; listeners.add(listener);
      listener({ state: 'ready', revision: '1', reset: true });
      return () => { stops++; listeners.delete(listener); };
    },
    emit(change: TaskHistoryChange) { for (const listener of [...listeners]) listener(change); },
    counts: () => ({ starts, stops, listeners: listeners.size }),
  };
}

test('底栏先订阅后读取，同步 ready 与重复 start 只首次读取，健康空闲一分钟无轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const source = notifications(), order: string[] = [];
  const value = fixture(async () => { order.push('list'); return { data: [job('running')], logId: 'first' }; },
    (listener) => { order.push('subscribe'); return source.subscribeChanges(listener); });
  const model = createTaskFooterModel(value.context);
  t.after(() => model.dispose());
  model.start(); model.start(); await flush();
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(order, ['subscribe', 'list']);
  assert.equal(source.counts().starts, 1);
  assert.equal(model.snapshot().pending, false);
});

test('底栏刷新期间 changed 合并补读一次，不取消请求也不丢最终快照', async (t) => {
  const source = notifications(); let calls = 0;
  let finish: () => void = () => undefined;
  let signal: AbortSignal | undefined;
  const value = fixture(async (current) => {
    if (++calls === 1) {
      signal = current;
      await new Promise<void>((resolve) => { finish = resolve; });
      return { data: [job('running')], logId: 'old' };
    }
    return { data: [job('succeeded')], logId: 'new' };
  }, source.subscribeChanges);
  const model = createTaskFooterModel(value.context);
  t.after(() => model.dispose());
  model.start(); await flush();
  source.emit({ state: 'changed', revision: '2', reset: false });
  source.emit({ state: 'changed', revision: '3', reset: false });
  assert.equal(calls, 1); assert.equal(signal?.aborted, false);
  finish(); await flush();
  assert.equal(calls, 2); assert.equal(model.snapshot().logId, 'new');
});

test('底栏断线按三秒降级，恢复重读后停止轮询，缺订阅仍按旧节奏刷新', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const source = notifications(); let calls = 0, oldCalls = 0;
  const value = fixture(async () => { calls++; return { data: [], logId: null }; }, source.subscribeChanges);
  const legacy = fixture(async () => { oldCalls++; return { data: [], logId: null }; });
  const model = createTaskFooterModel(value.context), old = createTaskFooterModel(legacy.context);
  t.after(() => { model.dispose(); old.dispose(); });
  model.start(); old.start(); await flush();
  source.emit({ state: 'unavailable', revision: '1', reset: false });
  t.mock.timers.tick(3_000); await flush();
  assert.equal(calls, 2); assert.equal(oldCalls, 2);
  source.emit({ state: 'ready', revision: '8', reset: true }); await flush();
  assert.equal(calls, 3);
  old.dispose();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(calls, 3); assert.equal(oldCalls, 2);
});

test('底栏释放同时取消在途请求、通知和定时器，晚结果不覆盖旧观测', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const source = notifications(); let calls = 0, aborted = false;
  let finish: (result: HostResult<readonly HistoricalJob[]>) => void = () => undefined;
  const value = fixture(async (signal) => {
    if (++calls === 1) return { data: [job('running')], logId: 'last' };
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise((resolve) => { finish = resolve; });
  }, source.subscribeChanges);
  const model = createTaskFooterModel(value.context);
  model.start(); await flush();
  source.emit({ state: 'changed', revision: '2', reset: false }); await flush();
  value.lifetime.abort(); model.dispose();
  finish({ data: [job('succeeded')], logId: 'late' }); await flush();
  source.emit({ state: 'ready', revision: '3', reset: true });
  model.start(); await model.refresh(); t.mock.timers.tick(60_000); await flush();
  assert.equal(calls, 2); assert.equal(aborted, true);
  assert.equal(model.snapshot().logId, 'last');
  assert.deepEqual(source.counts(), { starts: 1, stops: 1, listeners: 0 });
});

test('底栏订阅者抛错不阻断其他消费者，读取失败保留数据与日志且可继续刷新', async (t) => {
  const source = notifications(); let calls = 0, notices = 0;
  const value = fixture(async () => {
    if (++calls === 2) throw new Error('临时读取失败');
    return { data: [job('running')], logId: 'existing-log' };
  }, source.subscribeChanges);
  const model = createTaskFooterModel(value.context);
  t.after(() => model.dispose());
  model.subscribe(() => { throw new Error('单个视图错误'); });
  model.subscribe(() => { notices++; });
  model.start(); await flush();
  source.emit({ state: 'changed', revision: '2', reset: false }); await flush();
  assert.ok(model.snapshot().error); assert.equal(model.snapshot().logId, 'existing-log');
  assert.equal(model.snapshot().jobs[0]?.status, 'running');
  source.emit({ state: 'changed', revision: '3', reset: false }); await flush();
  assert.equal(model.snapshot().error, null); assert.equal(calls, 3); assert.ok(notices > 0);
});

test('底栏 ready 后快照失败保留降级刷新，成功后才停止轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const source = notifications(); let calls = 0;
  const value = fixture(async () => {
    if (++calls === 1) throw new Error('快照尚未恢复');
    return { data: [job('running')], logId: 'recovered' };
  }, source.subscribeChanges);
  const model = createTaskFooterModel(value.context);
  t.after(() => model.dispose());
  model.start(); await flush(); assert.ok(model.snapshot().error);
  t.mock.timers.tick(3_000); await flush();
  assert.equal(calls, 2); assert.equal(model.snapshot().error, null);
  t.mock.timers.tick(60_000); await flush(); assert.equal(calls, 2);
});
