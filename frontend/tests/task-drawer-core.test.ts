import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { HistoricalJob, HostContext, HostResult, JobEvent, WorkspacePageInfo } from '../src/plugin-sdk/index.ts';
registerHooks({ resolve(specifier, context, next) {
  return specifier === '@deviceforge/plugin-sdk'
    ? { url: new URL('../src/plugin-sdk/index.ts', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { createTaskDetailsModel } = await import('../plugins/tasks/src/drawer-details.ts');
const { resolveTaskPage, taskPageJobs, filterTaskJobs } = await import('../plugins/tasks/src/drawer-rules.ts');
function job(id: string, operation = 'sample.read', status: HistoricalJob['status'] = 'succeeded'): HistoricalJob {
  return { id, operation, status, createdAt: 1, error: null, result: null, input: {} };
}
function fixture(get: NonNullable<HostContext['taskHistory']>['get'],
  events: NonNullable<HostContext['taskHistory']>['events'] = async (id) => ({ data: [
    { jobId: id, status: 'succeeded', sequence: 1, timestamp: 1 },
  ], logId: 'events-log' })) {
  const lifetime = new AbortController();
  const forbidden = async (): Promise<never> => { throw new Error('不得派发或取消后台任务'); };
  const context: HostContext = { apiVersion: 2, signal: lifetime.signal, onDispose: (release) => release,
    listOperations: forbidden, subscribeOperations: () => () => {}, submit: forbidden, cancelJob: forbidden, getJob: forbidden,
    taskHistory: { get, events, list: forbidden },
  };
  return { context, lifetime };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('任务范围只依赖公开页面和精确操作，缺失或冲突不退回全部，筛选不改输入', () => {
  const a: WorkspacePageInfo = { id: 'sample.a', pluginId: 'sample', generation: 1, title: '甲', route: '/a',
    workspaceId: 'sample.workspace', operations: ['sample.read'], navigation: { order: 20 } };
  const b: WorkspacePageInfo = { ...a, id: 'sample.b', route: '/b', navigation: { order: 10 } };
  assert.equal(resolveTaskPage([a, b], '').page?.id, b.id);
  assert.equal(resolveTaskPage([a, b], '#/a/').page?.id, a.id);
  assert.equal(resolveTaskPage([a], '#/a/child').reason, 'missing');
  assert.equal(resolveTaskPage([a, { ...a, id: 'other.a' }], '#/a').reason, 'conflict');
  const jobs = [job('older'), { ...job('new', 'sample.read', 'failed'), createdAt: 2 },
    job('prefix', 'sample.read.extra'), job('active', 'sample.write', 'running')];
  assert.deepEqual(taskPageJobs(jobs, a).map((entry) => entry.id), ['new', 'older']);
  assert.equal(taskPageJobs(jobs, null).length, 0);
  assert.equal(taskPageJobs(jobs, { ...a, taskPolicy: 'all' }).length, 4);
  assert.deepEqual(filterTaskJobs(jobs, 'active').map((entry) => entry.id), ['active']);
  assert.deepEqual(filterTaskJobs(jobs, 'failed').map((entry) => entry.id), ['new']);
  assert.equal(jobs[0]?.id, 'older');
});

test('任务明细仅读取指定历史和事件，日志及原状态保留，不提交或取消业务', async () => {
  const calls: string[] = [];
  const value = fixture(async (id) => { calls.push(id); return { data: job(id), logId: 'read-log' }; });
  const model = createTaskDetailsModel(value.context);
  try {
    assert.deepEqual(calls, []);
    await model.read('sample-id');
    assert.deepEqual(calls, ['sample-id']);
    assert.equal(model.snapshot().job?.status, 'succeeded');
    assert.equal(model.snapshot().events[0]?.jobId, 'sample-id');
    assert.equal(model.snapshot().logId, 'read-log');
    assert.equal(model.snapshot().pending, false);
    assert.equal(model.snapshot().error, null);
  } finally { model.dispose(); }
});

test('错误任务或事件归属明确失败并保留对应日志，不冻结后续独立读取', async () => {
  let kind = 'get';
  const value = fixture(async (id) => ({ data: job(kind === 'get' ? 'wrong' : id), logId: 'get-log' }),
    async (id) => ({ data: [{ jobId: kind === 'events' ? 'wrong' : id, sequence: 1, timestamp: 1, status: 'failed' }], logId: 'event-log' }));
  const model = createTaskDetailsModel(value.context);
  try {
    await model.read('same'); assert.match(model.snapshot().error ?? '', /归属/);
    assert.equal(model.snapshot().logId, 'get-log'); assert.equal(model.snapshot().job, null);
    kind = 'events'; await model.read('same'); assert.match(model.snapshot().error ?? '', /归属/);
    assert.equal(model.snapshot().logId, 'event-log');
    kind = 'valid'; await model.read('same'); assert.equal(model.snapshot().error, null);
  } finally { model.dispose(); }
});

test('忽略取消的上游明细读取仍超时退出，晚到结果不复活且不自动重试', async () => {
  const late = deferred<HostResult<HistoricalJob>>();
  let calls = 0;
  const value = fixture(async () => { calls++; return late.promise; });
  const model = createTaskDetailsModel(value.context, { timeoutMs: 8 });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await model.read('slow');
    assert.match(model.snapshot().error ?? '', /超时/);
    assert.equal(model.snapshot().pending, false);
    const failed = model.snapshot();
    late.resolve({ data: job('slow'), logId: 'late-log' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(model.snapshot(), failed); assert.equal(calls, 1);
  } finally { clearTimeout(keepAlive); model.dispose(); }
});

test('换任务、收起和作用域撤销立即结束旧等待，旧结果不能覆盖新选择', async () => {
  const old = deferred<HostResult<HistoricalJob>>(), pendingEvents = deferred<HostResult<readonly JobEvent[]>>();
  const closed = deferred<HostResult<HistoricalJob>>();
  const value = fixture(async (id) => id === 'old' ? old.promise : id === 'closed' ? closed.promise : { data: job(id), logId: 'new-log' },
    async (id) => id === 'old' ? pendingEvents.promise : { data: [], logId: null });
  const model = createTaskDetailsModel(value.context);
  const first = model.read('old');
  await model.read('new'); await first;
  assert.equal(model.snapshot().job?.id, 'new');
  old.resolve({ data: job('old'), logId: 'old-log' });
  pendingEvents.resolve({ data: [], logId: null });
  await Promise.resolve(); assert.equal(model.snapshot().logId, 'new-log');
  const closing = model.read('closed'); assert.equal(model.snapshot().pending, true);
  model.clear(); await closing; assert.equal(model.snapshot().id, null); assert.equal(model.snapshot().job, null);
  const ending = model.read('closed'); value.lifetime.abort(); await ending; await model.read('forbidden');
  assert.equal(model.snapshot().pending, false); assert.notEqual(model.snapshot().id, 'forbidden');
  closed.resolve({ data: job('closed'), logId: 'closed-late' });
  await Promise.resolve(); assert.equal(model.snapshot().job, null);
  model.dispose();
});

test('无效期限或编号在读取前拒绝，已撤销上下文不启动新的请求', async () => {
  let calls = 0;
  const value = fixture(async (id) => { calls++; return { data: job(id), logId: null }; });
  assert.throws(() => createTaskDetailsModel(value.context, { timeoutMs: 1.5 }), /期限/);
  const model = createTaskDetailsModel(value.context);
  await model.read(' bad '); assert.match(model.snapshot().error ?? '', /编号/); assert.equal(calls, 0);
  value.lifetime.abort(); await model.read('valid'); assert.equal(calls, 0);
  model.dispose();
});
