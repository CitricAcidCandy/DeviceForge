import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient } from '../src/shared/api/index.ts';
import type { ApiResult } from '../src/shared/api/types.ts';
import { createLatestResource } from '../src/shared/lifecycle/latest.ts';
import { createTasks } from '../src/features/tasks/index.ts';
import { deferred, job, requestUrl, signal, success } from './fixtures.ts';

const stale = (error: unknown) => error instanceof ApiError && error.code === 'stale_result';
const value = (data: string): ApiResult<string> => ({ data, logId: data });

test('待处理通知重入新读取时，旧请求没有副作用且新快照保留', async () => {
  const resource = createLatestResource<string>();
  const replacements: Promise<ApiResult<string>>[] = [];
  let replace = true;
  let oldCalls = 0;
  resource.subscribe((snapshot) => {
    if (replace && snapshot.pending) {
      replace = false;
      replacements.push(resource.run(async () => value('new'), signal()));
    }
  });
  await assert.rejects(resource.run(async () => { ++oldCalls; return value('old'); }, signal()), stale);
  await Promise.all(replacements);
  assert.equal(oldCalls, 0);
  assert.equal(resource.snapshot().result?.data, 'new');
  resource.dispose();
});

test('成功通知重入时，后续订阅者和原调用都不能交付旧成功', async () => {
  const resource = createLatestResource<string>();
  const replacements: Promise<ApiResult<string>>[] = [];
  const seen: string[] = [];
  resource.subscribe((snapshot) => {
    if (!snapshot.pending && snapshot.result?.data === 'old') {
      replacements.push(resource.run(async () => value('new'), signal()));
    }
  });
  resource.subscribe((snapshot) => { if (!snapshot.pending && snapshot.result) seen.push(snapshot.result.data); });
  await assert.rejects(resource.run(async () => value('old'), signal()), stale);
  await Promise.all(replacements);
  assert.deepEqual(seen, ['new']);
  assert.equal(resource.snapshot().result?.data, 'new');
  resource.dispose();
});

test('订阅同步销毁后，不再触发旧请求或剩余通知', async () => {
  const resource = createLatestResource<string>();
  let calls = 0;
  let notices = 0;
  resource.subscribe(() => resource.dispose());
  resource.subscribe(() => { ++notices; });
  await assert.rejects(resource.run(async () => { ++calls; return value('old'); }, signal()), stale);
  assert.equal(calls, 0);
  assert.equal(notices, 0);
  assert.equal(resource.snapshot().pending, false);
});

test('前代取消监听重入第三次读取时，不执行被替代的第二次请求', async () => {
  const resource = createLatestResource<string>();
  const gate = deferred<ApiResult<string>>();
  const replacements: Promise<ApiResult<string>>[] = [];
  let middleCalls = 0;
  const first = resource.run((current) => {
    current.addEventListener('abort', () => {
      replacements.push(resource.run(async () => value('third'), signal()));
    }, { once: true });
    return gate.promise;
  }, signal());
  const firstFailure = assert.rejects(first, stale);
  await assert.rejects(resource.run(async () => { ++middleCalls; return value('second'); }, signal()), stale);
  await Promise.all(replacements);
  gate.resolve(value('first'));
  await firstFailure;
  assert.equal(middleCalls, 0);
  assert.equal(resource.snapshot().result?.data, 'third');
  resource.dispose();
});

test('通知中撤销的订阅立即失效，新增订阅只接收后续通知', async () => {
  const resource = createLatestResource<string>();
  const seen: string[] = [];
  let first = true;
  let remove = () => {};
  resource.subscribe(() => {
    if (!first) return;
    first = false;
    remove();
    resource.subscribe((snapshot) => { seen.push(snapshot.pending ? 'new-pending' : 'new-done'); });
  });
  remove = resource.subscribe(() => { seen.push('removed'); });
  await resource.run(async () => value('current'), signal());
  assert.deepEqual(seen, ['new-done']);
  resource.dispose();
});

test('失败通知重入的新读取保留新结果，不向后续订阅投递旧错误', async () => {
  const resource = createLatestResource<string>();
  const replacements: Promise<ApiResult<string>>[] = [];
  const seen: unknown[] = [];
  const failure = new Error('原读取失败');
  resource.subscribe((snapshot) => {
    if (snapshot.error === failure) replacements.push(resource.run(async () => value('recovered'), signal()));
  });
  resource.subscribe((snapshot) => { if (snapshot.error !== null) seen.push(snapshot.error); });
  await assert.rejects(resource.run(async () => { throw failure; }, signal()), failure);
  await Promise.all(replacements);
  assert.deepEqual(seen, []);
  assert.equal(resource.snapshot().result?.data, 'recovered');
  resource.dispose();
});

test('实际任务选择的成功通知重入后，原选择被撤销且订阅只看到新任务', async () => {
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (url) => {
    return success(job(requestUrl(url).pathname.endsWith('/old') ? 'old' : 'new'));
  } });
  const tasks = createTasks(client);
  const replacements: Promise<unknown>[] = [];
  const seen: string[] = [];
  tasks.subscribe((snapshot) => {
    if (!snapshot.pending && snapshot.result?.data.id === 'old') replacements.push(tasks.select('new', signal()));
  });
  tasks.subscribe((snapshot) => { if (!snapshot.pending && snapshot.result) seen.push(snapshot.result.data.id); });
  await assert.rejects(tasks.select('old', signal()), stale);
  await Promise.all(replacements);
  assert.deepEqual(seen, ['new']);
  assert.equal(tasks.snapshot().result?.data.id, 'new');
  tasks.dispose();
});

test('同一回调重新登记有新身份，旧解除函数不能删除它', async () => {
  const resource = createLatestResource<string>();
  const seen: string[] = [];
  let replace = true;
  let remove = () => {};
  const listener = (snapshot: { pending: boolean }) => { seen.push(snapshot.pending ? 'pending' : 'done'); };
  resource.subscribe(() => {
    if (!replace) return;
    replace = false;
    remove();
    resource.subscribe(listener);
    remove();
  });
  remove = resource.subscribe(listener);
  await resource.run(async () => value('current'), signal());
  assert.deepEqual(seen, ['done']);
  resource.dispose();
});

test('成功快照接受后仅取消调用方信号，所有订阅与原调用仍得到相同成功', async () => {
  const resource = createLatestResource<string>();
  const cancellation = new AbortController();
  const seen: string[] = [];
  resource.subscribe((snapshot) => { if (!snapshot.pending && snapshot.result) cancellation.abort(); });
  resource.subscribe((snapshot) => { if (!snapshot.pending && snapshot.result && snapshot.error === null) seen.push(snapshot.result.data); });
  assert.equal((await resource.run(async () => value('accepted'), cancellation.signal)).data, 'accepted');
  assert.deepEqual(seen, ['accepted']);
  assert.equal(resource.snapshot().error, null);
  resource.dispose();
});
