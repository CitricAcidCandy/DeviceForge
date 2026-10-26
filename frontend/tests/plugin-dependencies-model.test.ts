import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginDependencies } from '../src/features/plugin-dependencies/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import { dependenciesView, dependency, dependencyEvent, dependencyJob } from './plugin-dependencies-fixtures.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

const target = dependenciesView().target;
function model(transport: typeof fetch, waitTimeoutMs = 2000) {
  return createPluginDependencies(createApiClient({ baseUrl: 'http://localhost', transport }), target,
    { pollIntervalMs: 0, waitTimeoutMs });
}

test('安装全部只选择可安装的缺失必需项，轮询公开任务后 GET 新修订', async (t) => {
  let installed = false, polls = 0;
  const posts: unknown[] = [];
  const states: string[] = [];
  const instance = model(async (input, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body))); installed = true;
      return success(dependencyJob({ status: 'queued' }), 'submit-log');
    }
    if (requestUrl(input).pathname.endsWith('/events')) return success([]);
    if (requestUrl(input).pathname.includes('/jobs/')) return success(dependencyJob({ status: ++polls === 1 ? 'running' : 'succeeded' }));
    return success(installed ? dependenciesView({ revision: 'r2', dependencies: [], ready: true }) : dependenciesView({ dependencies: [
      dependency(), dependency({ id: 'optional', required: false }), dependency({ id: 'manual', installable: false }),
      dependency({ id: 'wrong', status: 'incompatible' }), dependency({ id: 'failed', status: 'failed' }),
    ] }));
  });
  t.after(() => instance.dispose());
  const unsubscribe = instance.subscribe(() => states.push(`${instance.snapshot().phase}:${instance.snapshot().job?.status}`));
  t.after(unsubscribe);
  await instance.refresh(signal());
  await instance.installRequired(signal());
  assert.deepEqual(posts, [{ expected_revision: 'revision-1', dependency_ids: ['adb'] }]);
  assert.ok(states.includes('installing:running'));
  assert.equal(instance.snapshot().result?.data.revision, 'r2');
  assert.equal(instance.snapshot().ticket, null);
  assert.equal(instance.snapshot().stale, false);
});

test('单项可选安装及重新检测沿最新修订，不调用通用 submit 或自动安装可选项', async (t) => {
  let reads = 0;
  const writes: { path: string; body: unknown }[] = [];
  const instance = model(async (input, init) => {
    const path = requestUrl(input).pathname;
    assert.notEqual(path, '/api/v2/jobs');
    if (init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(String(init.body)) }); return success(dependencyJob());
    }
    if (path.endsWith('/events')) return success([]);
    if (path.includes('/jobs/')) return success(dependencyJob());
    return success(dependenciesView({ revision: `r${++reads}`, dependencies: [dependency({ required: false })], ready: true }));
  });
  t.after(() => instance.dispose());
  await instance.refresh(signal());
  await assert.rejects(instance.installRequired(signal()), /没有可安装/);
  await instance.installDependency('adb', signal());
  await instance.scan(signal());
  assert.deepEqual(writes, [
    { path: '/api/v2/plugin-dependencies/release/example/install', body: { expected_revision: 'r1', dependency_ids: ['adb'] } },
    { path: '/api/v2/plugin-dependencies/release/example/scan', body: { expected_revision: 'r2' } },
  ]);
});

test('任务失败保留真实日志 ID、重读视图，后续成功不擦掉旧错误', async (t) => {
  let failed = true;
  const instance = model(async (input, init) => {
    if (init?.method === 'POST') return success(dependencyJob({ status: 'queued' }), 'submission-log');
    if (requestUrl(input).pathname.endsWith('/events')) return success([]);
    if (requestUrl(input).pathname.includes('/jobs/')) return success(dependencyJob({ status: failed ? 'failed' : 'succeeded', error: failed ? '安装工具失败' : null }), 'job-log');
    return success(dependenciesView());
  });
  t.after(() => instance.dispose());
  await instance.refresh(signal());
  await assert.rejects(instance.installRequired(signal()), /安装工具失败/);
  assert.deepEqual(instance.snapshot().issues, [{ message: '安装工具失败', logId: 'job-log' }]);
  assert.equal(instance.snapshot().ticket, null);
  failed = false;
  await instance.scan(signal());
  assert.equal(instance.snapshot().issues.length, 1);
  assert.equal(instance.snapshot().issues[0]?.logId, 'job-log');
});

test('修订冲突只重读不重放 POST，重读失败不覆盖原始日志', async (t) => {
  let reads = 0, posts = 0;
  const instance = model(async (_, init) => {
    if (init?.method === 'POST') { ++posts; return failure('revision_conflict'); }
    if (++reads > 1) return failure('read_failure', 503);
    return success(dependenciesView());
  });
  t.after(() => instance.dispose());
  await instance.refresh(signal());
  await assert.rejects(instance.scan(signal()), (error: unknown) => error instanceof ApiError && error.code === 'revision_conflict');
  assert.equal(posts, 1);
  assert.equal(reads, 2);
  assert.equal(instance.snapshot().issues.length, 2);
  assert.equal(instance.snapshot().stale, true);
});

test('停止轮询保留任务，查询真实终态不重放提交，取消不是服务器取消', async (t) => {
  const entered = deferred<void>(), late = deferred<Response>();
  let hold = true, posts = 0;
  const paths: string[] = [];
  const instance = model(async (input, init) => {
    const path = requestUrl(input).pathname;
    paths.push(path);
    if (init?.method === 'POST') { ++posts; return success(dependencyJob({ status: 'queued' })); }
    if (path.endsWith('/events')) return success([]);
    if (path.includes('/jobs/')) {
      if (hold) { entered.resolve(); return late.promise; }
      return success(dependencyJob());
    }
    return success(dependenciesView());
  });
  t.after(() => instance.dispose());
  await instance.refresh(signal());
  const pending = instance.installRequired(signal());
  const rejected = assert.rejects(pending);
  await entered.promise;
  instance.cancel();
  await rejected;
  assert.equal(instance.snapshot().phase, 'idle');
  assert.equal(instance.snapshot().ticket?.id, 'dependency-task');
  await assert.rejects(instance.scan(signal()), /先查询/);
  hold = false;
  await instance.query(signal());
  late.resolve(success(dependencyJob({ status: 'failed', error: '迟到失败' })));
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(posts, 1);
  assert.ok(paths.every((path) => !path.endsWith('/cancel')));
  assert.equal(instance.snapshot().ticket, null);
  assert.equal(instance.snapshot().job?.status, 'succeeded');
});

test('旧 GET 取消后新读取可立即成功，销毁撤销等待与订阅，迟到结果不覆盖', async () => {
  const entered = deferred<void>(), late = deferred<Response>();
  let reads = 0, notices = 0;
  const instance = model(async () => {
    if (++reads === 1) { entered.resolve(); return late.promise; }
    return success(dependenciesView({ revision: 'r2' }));
  });
  instance.subscribe(() => { ++notices; });
  const waiting = instance.refresh(signal());
  const rejected = assert.rejects(waiting);
  await entered.promise;
  await assert.rejects(instance.refresh(signal()), /尚未结束/);
  instance.cancel();
  await rejected;
  await instance.refresh(signal());
  late.resolve(success(dependenciesView({ revision: 'old' })));
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(instance.snapshot().result?.data.revision, 'r2');
  instance.dispose();
  const count = notices;
  await assert.rejects(instance.refresh(signal()), /已关闭/);
  assert.equal(notices, count);
});

test('网络未知提交不自动重试或误报成功，必须先显式读取', async (t) => {
  let posts = 0;
  const instance = model(async (_, init) => {
    if (init?.method === 'POST') { ++posts; throw new Error('private transport'); }
    return success(dependenciesView());
  });
  t.after(() => instance.dispose());
  await instance.refresh(signal());
  await assert.rejects(instance.scan(signal()), /无法取得/);
  await assert.rejects(instance.scan(signal()), /先读取/);
  assert.equal(posts, 1);
  assert.equal(instance.snapshot().stale, true);
});

test('server 组件归并完整发布后使用 canonical target 与修订提交，失效后重新读取仍走原入口', async (t) => {
  const requests: { path: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
    const path = requestUrl(input).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.endsWith('/events')) return success([]);
    if (init?.method === 'POST' || path.includes('/jobs/')) return success(dependencyJob());
    return success(dependenciesView());
  } });
  const instance = createPluginDependencies(client, { kind: 'server', id: 'owned-component' }, { pollIntervalMs: 0 });
  t.after(() => instance.dispose());
  await instance.refresh(signal());
  await instance.installRequired(signal());
  assert.equal(requests[0]?.path, '/api/v2/plugin-dependencies/server/owned-component');
  assert.equal(requests[1]?.path, '/api/v2/plugin-dependencies/release/example/install');
  assert.deepEqual(requests[1]?.body, { expected_revision: 'revision-1', dependency_ids: ['adb'] });
  assert.equal(requests.at(-1)?.path, '/api/v2/plugin-dependencies/server/owned-component');
});

test('有界等待超时释放前台并保留已知任务票据，不自动取消服务器或重复提交', async (t) => {
  let posts = 0;
  const hold = deferred<Response>();
  const keepalive = setTimeout(() => undefined, 2000);
  t.after(() => { clearTimeout(keepalive); });
  const instance = model(async (input, init) => {
    if (init?.method === 'POST') { ++posts; return success(dependencyJob({ status: 'queued' })); }
    if (requestUrl(input).pathname.includes('/jobs/')) return hold.promise;
    return success(dependenciesView());
  }, 25);
  t.after(() => { instance.dispose(); hold.resolve(success(dependencyJob())); });
  await instance.refresh(signal());
  await assert.rejects(instance.installRequired(signal()));
  assert.equal(instance.snapshot().phase, 'idle');
  assert.equal(instance.snapshot().ticket?.id, 'dependency-task');
  assert.match(instance.snapshot().notice ?? '', /服务器任务可能仍在执行/);
  assert.equal(posts, 1);
});

test('依赖进度只消费公开事件，按序列增量读取，未知总量不伪造百分比，任务和读取日志独立', async (t) => {
  let polls = 0;
  const cursors: string[] = [], stages: string[] = [];
  const instance = model(async (input, init) => {
    const url = requestUrl(input);
    if (init?.method === 'POST') return success(dependencyJob({ status: 'queued' }), 'submit-log');
    if (url.pathname.endsWith('/events')) {
      cursors.push(url.searchParams.get('after') ?? '');
      return success([dependencyEvent(polls === 1
        ? { progress: { stage: 'downloading', resource_id: 'adb', completed_bytes: 25, total_bytes: null } }
        : { sequence: 2, status: 'succeeded', progress: { stage: 'complete', completed_bytes: 100, total_bytes: 100 } })], 'event-log');
    }
    if (url.pathname.includes('/jobs/')) return success(dependencyJob({ status: ++polls === 1 ? 'running' : 'succeeded' }), 'job-log');
    return success(dependenciesView(), 'view-log');
  });
  t.after(() => instance.dispose());
  instance.subscribe(() => {
    if (instance.snapshot().progress) stages.push(`${instance.snapshot().progress?.stage}:${instance.snapshot().progress?.total_bytes}`);
  });
  await instance.refresh(signal());
  await instance.installRequired(signal());
  assert.deepEqual(cursors, ['0', '1']);
  assert.ok(stages.includes('downloading:null'));
  assert.equal(instance.snapshot().progress?.stage, 'complete');
  assert.equal(instance.snapshot().logId, 'view-log');
  assert.equal(instance.snapshot().job?.id, 'dependency-task');
  assert.deepEqual(instance.snapshot().issues, []);
});

test('事件串任务、倒序或读取失败保持真实诊断，不抹旧错也不把已确认任务终态改成失败', async (t) => {
  for (const events of [[dependencyEvent({ job_id: 'other' })],
    [dependencyEvent(), dependencyEvent()], null]) {
    const instance = model(async (input, init) => {
      const path = requestUrl(input).pathname;
      if (init?.method === 'POST') return success(dependencyJob({ status: 'queued' }));
      if (path.endsWith('/events')) return events ? success(events, 'event-error-log') : failure('events_unavailable', 503);
      if (path.includes('/jobs/')) return success(dependencyJob());
      return success(dependenciesView());
    });
    t.after(() => instance.dispose());
    await instance.refresh(signal());
    await instance.installRequired(signal());
    assert.equal(instance.snapshot().job?.status, 'succeeded');
    assert.equal(instance.snapshot().ticket, null);
    assert.equal(instance.snapshot().stale, false);
    assert.equal(instance.snapshot().progress, null);
    assert.equal(instance.snapshot().issues.length, 1);
    assert.equal(instance.snapshot().issues[0]?.logId, events ? 'event-error-log' : 'log-error');
  }
});
