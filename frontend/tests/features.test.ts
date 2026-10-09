import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient, ApiError } from '../src/shared/api/index.ts';
import { createLatestResource } from '../src/shared/lifecycle/latest.ts';
import { createOperations } from '../src/features/operations/index.ts';
import { createTasks } from '../src/features/tasks/index.ts';
import { createServerPlugins } from '../src/features/server-plugins/index.ts';
import { deferred, failure, job, plugin, requestUrl, signal, success } from './fixtures.ts';

test('最新资源在下游忽略取消时拒绝旧结果，订阅失败不污染其他订阅', async () => {
  const resource = createLatestResource<string>();
  const old = deferred<{ data: string; logId: string }>();
  const seen: string[] = [];
  resource.subscribe(() => { throw new Error('订阅失败'); });
  const unsubscribe = resource.subscribe((snapshot) => { if (snapshot.result) seen.push(snapshot.result.data); });
  const first = resource.run(() => old.promise, signal());
  const firstFailure = assert.rejects(first, (error: unknown) => error instanceof ApiError && error.code === 'stale_result');
  await resource.run(async () => ({ data: 'new', logId: 'new-log' }), signal());
  old.resolve({ data: 'old', logId: 'old-log' }); await firstFailure;
  assert.equal(resource.snapshot().result?.data, 'new'); assert.deepEqual(seen, ['new']);
  unsubscribe(); resource.dispose();
  await assert.rejects(resource.run(async () => ({ data: 'closed', logId: null }), signal()), /关闭/);
});

test('操作目录和任务用例消费真实端点，选择变化不被旧响应覆盖', async () => {
  const old = deferred<Response>(); const entered = deferred<void>();
  const urls: string[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (url, init) => {
    const path = requestUrl(url).pathname; urls.push(`${init?.method} ${path}${requestUrl(url).search}`);
    if (path.endsWith('/operations')) return success([{ id: 'example.run', title: '运行', input_schema: {} }]);
    if (path.endsWith('/old')) { entered.resolve(); return old.promise; }
    if (path.endsWith('/events')) return success([{ job_id: 'new', sequence: 2, timestamp: 1, status: 'queued' }]);
    if (path === '/api/v2/jobs' && init?.method === 'GET') return success([job('new')]);
    return success(job('new'));
  } });
  const operations = createOperations(client); const tasks = createTasks(client);
  let notices = 0; operations.subscribe(() => { ++notices; });
  await operations.refresh(signal()); assert.equal(operations.snapshot().result?.data.length, 1); assert.equal(notices, 2);
  const first = tasks.select('old', signal());
  const firstFailure = assert.rejects(first, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise; await tasks.select('new', signal()); old.resolve(success(job('old'))); await firstFailure;
  assert.equal(tasks.snapshot().result?.data.id, 'new');
  await tasks.list({ limit: 4 }, signal()); await tasks.submit({ operation: 'example.run', input: null }, signal());
  await tasks.cancel('new', signal()); await tasks.events('new', { after: 1 }, signal());
  assert.ok(urls.includes('GET /api/v2/jobs?limit=4')); assert.ok(urls.includes('GET /api/v2/jobs/new/events?after=1'));
  operations.dispose(); tasks.dispose();
  await assert.rejects(operations.list(signal()), /取消/); await assert.rejects(tasks.get('new', signal()), /取消/);
});

test('管理取消后仍读取真实 draining/cleanup_failed 并刷新目录，不重放变更', async () => {
  const began = deferred<void>(); const response = deferred<Response>();
  let posts = 0; let queries = 0; let refreshes = 0;
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (_url, init) => {
    if (init?.method === 'POST') { ++posts; began.resolve(); return response.promise; }
    ++queries; return success([plugin({ state: 'draining', cleanup_failed: true })]);
  } });
  const management = createServerPlugins(client, async () => { ++refreshes; });
  const cancellation = new AbortController();
  const waiting = management.unload('example', cancellation.signal);
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await began.promise; cancellation.abort(); await rejected;
  response.resolve(failure('cleanup_failed'));
  assert.equal(posts, 1); assert.equal(queries, 1); assert.equal(refreshes, 1);
  assert.equal(management.snapshot().result?.data[0]?.state, 'draining');
  assert.equal(management.snapshot().result?.data[0]?.cleanup_failed, true); management.dispose();
});

test('管理变更串行且错误后继续下一项，每次变更后同步公开目录', async () => {
  const first = deferred<Response>(); const began = deferred<void>(); const calls: string[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (url, init) => {
    const path = requestUrl(url).pathname; calls.push(`${init?.method} ${path}`);
    if (path.endsWith('/load')) { began.resolve(); return first.promise; }
    if (path.endsWith('/unload')) return success(plugin({ state: 'unloaded' }));
    return success([]);
  } });
  const management = createServerPlugins(client, async () => { calls.push('目录刷新'); });
  const load = management.load('example', signal());
  const loadFailure = assert.rejects(load, (error: unknown) => error instanceof ApiError && error.code === 'cleanup_failed');
  const unload = management.unload('example', signal());
  await began.promise; assert.equal(calls.filter((entry) => entry.startsWith('POST')).length, 1);
  first.resolve(failure('cleanup_failed')); await loadFailure; await unload;
  const afterLoad = calls.indexOf('目录刷新'); const unloadIndex = calls.indexOf('POST /api/v2/plugins/example/unload');
  assert.ok(afterLoad >= 0 && unloadIndex > afterLoad); assert.equal(calls.filter((entry) => entry === '目录刷新').length, 2);
  management.dispose();
});
