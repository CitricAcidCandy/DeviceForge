import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginDependenciesHttp } from '../src/features/plugin-dependencies/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import { dependenciesView, dependency, dependencyJob } from './plugin-dependencies-fixtures.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

test('依赖公开客户端覆盖 release/server/browser，无 plugins 层并保留日志与信号', async () => {
  const kinds: readonly ('release' | 'server' | 'browser')[] = ['release', 'server', 'browser'];
  for (const kind of kinds) {
    const current = signal();
    const target = { kind, id: 'example with space' };
    const requests: { path: string; body: unknown }[] = [];
    const http = createPluginDependenciesHttp(createApiClient({
      baseUrl: 'http://backend.example', tokenProvider: () => 'test-token',
      transport: async (input, init) => {
        const path = requestUrl(input).pathname;
        assert.equal(init?.signal, current);
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
        requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
        return success(init?.method === 'GET' ? dependenciesView({ target }) : dependencyJob(), 'dependency-log');
      },
    }));
    assert.equal((await http.get(target, current)).logId, 'dependency-log');
    await http.scan({ target, expected_revision: 'r1' }, current);
    await http.install({ target, expected_revision: 'r2', dependency_ids: ['adb'] }, current);
    assert.deepEqual(requests, [
      { path: `/api/v2/plugin-dependencies/${kind}/example%20with%20space`, body: null },
      { path: `/api/v2/plugin-dependencies/${kind}/example%20with%20space/scan`, body: { expected_revision: 'r1' } },
      { path: `/api/v2/plugin-dependencies/${kind}/example%20with%20space/install`, body: { expected_revision: 'r2', dependency_ids: ['adb'] } },
    ]);
  }
});

test('依赖视图严格拒绝损坏字段、重复 ID、矛盾就绪及串目标，保留协议日志', async () => {
  const invalid: unknown[] = [null, {},
    dependenciesView({ revision: '' }), dependenciesView({ ready: true }),
    dependenciesView({ dependencies: [dependency(), dependency()] }),
    dependenciesView({ target: { kind: 'browser', id: 'other' } }),
    { ...dependenciesView(), dependencies: [{ ...dependency(), source: 'browser' }] },
    { ...dependenciesView(), dependencies: [{ ...dependency(), version: 2 }] },
    { ...dependenciesView(), dependencies: [{ ...dependency(), status: 'unknown' }] },
    { ...dependenciesView(), dependencies: [{ ...dependency(), installable: 'yes' }] },
    { ...dependenciesView(), dependencies: [{ ...dependency(), message: undefined }] },
  ];
  for (const value of invalid) {
    const http = createPluginDependenciesHttp(createApiClient({ baseUrl: 'http://localhost',
      transport: async () => success(value, 'invalid-log') }));
    await assert.rejects(http.get({ kind: 'release', id: 'example' }, signal()),
      (error: unknown) => error instanceof ApiError && error.kind === 'protocol' && error.logId === 'invalid-log');
  }
});

test('空依赖与可选缺失不阻塞 ready，所有已确认状态和来源均可消费', async () => {
  const statuses: readonly ('ready' | 'missing' | 'incompatible' | 'failed')[] = ['ready', 'missing', 'incompatible', 'failed'];
  const sources: readonly ('environment' | 'shared' | 'local' | null)[] = ['environment', 'shared', 'local', null];
  for (const dependencies of [[], ...statuses.flatMap((status) => sources.map((source) => [dependency({ status, source, required: false })]))]) {
    const http = createPluginDependenciesHttp(createApiClient({ baseUrl: 'http://localhost',
      transport: async () => success(dependenciesView({ dependencies, ready: true })) }));
    assert.equal((await http.get({ kind: 'release', id: 'example' }, signal())).data.ready, true);
  }
});

test('提交前拒绝空修订和无效选择，HTTP 409 不自动重放', async () => {
  let requests = 0;
  const http = createPluginDependenciesHttp(createApiClient({ baseUrl: 'http://localhost', transport: async () => {
    ++requests; return failure('revision_conflict');
  } }));
  const target = { kind: 'release', id: 'example' } satisfies Parameters<typeof http.get>[0];
  for (const body of [{ expected_revision: '' }, { expected_revision: 'r1', dependency_ids: [] },
    { expected_revision: 'r1', dependency_ids: ['adb', 'adb'] }, { expected_revision: 'r1', dependency_ids: [''] }])
    await assert.rejects(http.install({ target, ...body }, signal()), /当前修订和有效依赖标识/);
  assert.equal(requests, 0);
  await assert.rejects(http.install({ target, expected_revision: 'r1' }, signal()),
    (error: unknown) => error instanceof ApiError && error.code === 'revision_conflict' && error.logId === 'log-error');
  assert.equal(requests, 1);
});

test('POST 接受精简 TaskRecord，在途请求可取消且迟到响应不交付', async () => {
  const delayed = deferred<Response>();
  const controller = new AbortController();
  const http = createPluginDependenciesHttp(createApiClient({ baseUrl: 'http://localhost', transport: async () => delayed.promise }));
  const pending = http.scan({ target: { kind: 'release', id: 'example' }, expected_revision: 'r1' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  delayed.resolve(success(dependencyJob()));
  const compact = createPluginDependenciesHttp(createApiClient({ baseUrl: 'http://localhost', transport: async () =>
    success({ id: 'j1', operation: 'dependency.scan', status: 'queued' }) }));
  assert.equal((await compact.scan({ target: { kind: 'release', id: 'example' }, expected_revision: 'r1' }, signal())).data.id, 'j1');
});

test('依赖响应与写选择使用同一公开标识规则，不接受无法被后端补装的 ID', async () => {
  let writes = 0;
  for (const id of ['Atool', 'a'.repeat(100), 'builtin.tool', '_tool']) {
    const http = createPluginDependenciesHttp(createApiClient({ baseUrl: 'http://localhost', transport: async (_input, init) => {
      if (init?.method === 'POST') { ++writes; return success(dependencyJob()); }
      return success(dependenciesView({ dependencies: [dependency({ id })] }), 'invalid-identifier-log');
    } }));
    await assert.rejects(http.get({ kind: 'release', id: 'example' }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'invalid-identifier-log');
    await assert.rejects(http.install({ target: { kind: 'release', id: 'example' }, expected_revision: 'r1', dependency_ids: [id] }, signal()));
  }
  assert.equal(writes, 0);
  for (const id of ['3helper', 'a'.repeat(99)]) {
    const http = createPluginDependenciesHttp(createApiClient({ baseUrl: 'http://localhost', transport: async () =>
      success(dependenciesView({ dependencies: [dependency({ id })] })) }));
    assert.equal((await http.get({ kind: 'release', id: 'example' }, signal())).data.dependencies[0]?.id, id);
  }
});
