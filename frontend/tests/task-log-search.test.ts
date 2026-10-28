import assert from 'node:assert/strict';
import test from 'node:test';
import { createTasks } from '../src/features/tasks/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import { deferred, failure, job, requestUrl, signal, success } from './fixtures.ts';

const logId = 'd3be1c0c-eee8-43a6-9f47-f963ddbfc725';
const jobId = '31a501f3-ab38-4f84-8c70-d74bf6c86520';
function search(overrides: Record<string, unknown> = {}) {
  return { log_id: logId, entries: [{ timestamp: '2026-10-27T10:00:00Z', level: 'INFO', message: '响应已建立',
    job_id: jobId, operation: null, code: null, method: 'GET', route: '/api/v2/jobs/{id}', status: 200 }],
    job_ids: [jobId], limited: false, ...overrides };
}

test('日志编号回查服务器记录与关联任务，不受最近列表限制且全部只读', async () => {
  const requests: string[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (input, init) => {
    const url = requestUrl(input);
    requests.push(`${init?.method} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith(`/jobs/${logId}`)) return failure('not_found', 404);
    if (url.pathname.endsWith('/diagnostics/logs')) return success(search(), 'lookup-log');
    if (url.pathname.endsWith(`/jobs/${jobId}`)) return success({ ...job(jobId), status: 'failed', error: '未安装应用' });
    assert.fail('不应自动重放业务、发现设备或列出全部历史任务');
  } });
  const tasks = createTasks(client);
  try {
    const result = await tasks.lookup(logId, signal());
    assert.equal(result.logId, 'lookup-log');
    assert.equal(result.data.query, logId);
    assert.equal(result.data.jobs[0]?.status, 'failed');
    assert.equal(result.data.logs?.entries[0]?.status, 200);
    assert.deepEqual(requests, [`GET /api/v2/jobs/${logId}`, `GET /api/v2/diagnostics/logs?log_id=${logId}`, `GET /api/v2/jobs/${jobId}`]);
    assert.equal(tasks.snapshot().result, null);
  } finally { tasks.dispose(); }
});

test('任务编号直接读取，输入无效时零请求', async () => {
  const requests: string[] = [];
  const tasks = createTasks(createApiClient({ baseUrl: 'http://localhost', transport: async (input) => {
    requests.push(requestUrl(input).pathname); return success(job(jobId));
  } }));
  try {
    await assert.rejects(tasks.lookup('../private', signal()), (error: unknown) => error instanceof ApiError && error.code === 'invalid_input');
    assert.equal(requests.length, 0);
    const result = await tasks.lookup(jobId, signal());
    assert.equal(result.data.logs, null);
    assert.deepEqual(requests, [`/api/v2/jobs/${jobId}`]);
  } finally { tasks.dispose(); }
});

test('无关联任务与部分日志仍返回诊断，旧服务不伪装成没有日志', async () => {
  for (const mode of ['no-job', 'expired-job', 'old-server'] as const) {
    const tasks = createTasks(createApiClient({ baseUrl: 'http://localhost', transport: async (input) => {
      const url = requestUrl(input);
      if (url.pathname.includes('/jobs/')) return failure('not_found', 404);
      if (mode === 'old-server') return failure('not_found', 404);
      return success(search({ job_ids: mode === 'no-job' ? [] : [jobId], limited: true }));
    } }));
    try {
      if (mode === 'old-server') await assert.rejects(tasks.lookup(logId, signal()), (error: unknown) =>
        error instanceof ApiError && error.code === 'log_search_unavailable' && /升级服务/.test(error.message));
      else {
        const result = await tasks.lookup(logId, signal());
        assert.equal(result.data.jobs.length, 0);
        assert.equal(result.data.logs?.limited, true);
        assert.deepEqual(result.data.missingJobIds, mode === 'no-job' ? [] : [jobId]);
      }
    } finally { tasks.dispose(); }
  }
});

test('取消查询不接受忽略信号的迟到结果，也不继续查任务', async () => {
  const late = deferred<Response>();
  const started = deferred<void>();
  const requests: string[] = [];
  const tasks = createTasks(createApiClient({ baseUrl: 'http://localhost', transport: async (input) => {
    const url = requestUrl(input); requests.push(url.pathname);
    if (url.pathname.includes('/jobs/')) return failure('not_found', 404);
    started.resolve(); return late.promise;
  } }));
  const controller = new AbortController();
  try {
    const pending = tasks.lookup(logId, controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    late.resolve(success(search()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2);
  } finally { tasks.dispose(); }
});

test('错误编号、过量记录和无效结构均拒绝，不显示其他请求的日志', async () => {
  for (const output of [search({ log_id: jobId }), search({ entries: [{}] }), search({ job_ids: Array(21).fill(jobId) })]) {
    const tasks = createTasks(createApiClient({ baseUrl: 'http://localhost', transport: async (input) =>
      requestUrl(input).pathname.includes('/jobs/') ? failure('not_found', 404) : success(output) }));
    try { await assert.rejects(tasks.lookup(logId, signal()), (error: unknown) => error instanceof ApiError && error.kind === 'protocol'); }
    finally { tasks.dispose(); }
  }
});

test('关键词与排序发送到服务器，读取未加载到近期列表的历史关联任务', async () => {
  const requests: string[] = [];
  const tasks = createTasks(createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
    const url = requestUrl(input); requests.push(`${init?.method} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/diagnostics/logs')) {
      assert.equal(url.searchParams.get('q'), 'app.start');
      assert.equal(url.searchParams.has('log_id'), false);
      return success(search({ log_id: null, entries: [{ ...search().entries[0], log_id: logId }] }));
    }
    if (url.pathname.endsWith(`/jobs/${jobId}`)) return success({ ...job(jobId), operation: 'app.start' });
    assert.fail('搜索不得依赖近期列表或重放业务');
  } }));
  try {
    for (const order of ['desc', 'asc'] as const) {
      const result = await tasks.search(' app.start ', order, signal());
      assert.equal(result.data.query, 'app.start');
      assert.equal(result.data.logs?.log_id, null);
      assert.equal(result.data.logs?.entries[0]?.log_id, logId);
      assert.equal(result.data.jobs[0]?.id, jobId);
      assert.ok(requests.includes(`GET /api/v2/diagnostics/logs?q=app.start&order=${order}`));
    }
    assert.ok(requests.every((request) => request.startsWith('GET ')));
    assert.equal(requests.length, 4);
  } finally { tasks.dispose(); }
});

test('关键词无效时不请求，服务器拒绝旧查询参数时明确提示升级', async () => {
  let requests = 0;
  const tasks = createTasks(createApiClient({ baseUrl: 'http://localhost', transport: async () => {
    requests++; return failure('invalid_input', 400);
  } }));
  try {
    for (const query of ['', '  ', '包含\n换行', '界'.repeat(43)])
      await assert.rejects(tasks.search(query, 'desc', signal()), (error: unknown) => error instanceof ApiError && error.code === 'invalid_input');
    assert.equal(requests, 0);
    await assert.rejects(tasks.search('app.start', 'desc', signal()), (error: unknown) =>
      error instanceof ApiError && error.code === 'log_search_unavailable' && /更新服务/.test(error.message));
    assert.equal(requests, 1);
  } finally { tasks.dispose(); }
});

test('撤销关键词搜索后不接纳迟到日志，也不继续查询关联任务', async () => {
  const late = deferred<Response>();
  const started = deferred<void>();
  let requests = 0;
  const tasks = createTasks(createApiClient({ baseUrl: 'http://localhost', transport: async () => {
    requests++; started.resolve(); return late.promise;
  } }));
  const controller = new AbortController();
  try {
    const pending = tasks.search('app.start', 'desc', controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    late.resolve(success(search({ log_id: null })));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
  } finally { tasks.dispose(); }
});
