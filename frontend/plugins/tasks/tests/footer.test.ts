import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Dispose, HistoricalJob, HostContext, HostResult } from '@deviceforge/plugin-sdk';
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
function fixture(list: (signal: AbortSignal) => Promise<HostResult<readonly HistoricalJob[]>>) {
  const lifetime = new AbortController();
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, onDispose: (release) => release,
    listOperations: async () => { throw new Error('不应请求操作目录'); }, subscribeOperations: () => () => undefined,
    submit: async () => { throw new Error('不应提交任务'); },
    cancelJob: async () => { throw new Error('不应取消任务'); },
    getJob: async () => { throw new Error('不应查询单个任务'); },
    taskHistory: {
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
test('新读取撤销旧等待，晚到旧结果不覆盖新观测，卸载不残留刷新', async () => {
  let finish: ((value: HostResult<readonly HistoricalJob[]>) => void) | null = null;
  let calls = 0;
  const value = fixture(async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { finish = resolve; });
    return { data: [job('succeeded')], logId: 'new-log' };
  });
  const model = createTaskFooterModel(value.context, { intervalMs: 10 });
  const first = model.refresh();
  await model.refresh(); await first;
  const resolveOld = finish;
  if (resolveOld) {
    // 回调由请求实现设置，显式经局部容器保留实际类型。
    const invoke: (value: HostResult<readonly HistoricalJob[]>) => void = resolveOld;
    invoke({ data: [job('running')], logId: 'old-log' });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
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
