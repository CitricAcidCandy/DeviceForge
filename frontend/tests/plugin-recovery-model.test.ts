import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import { createPluginRecovery } from '../src/features/plugin-recovery/index.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

function view(overrides: Readonly<Record<string, unknown>> = {}) {
  return { id: 'mirroring', generation: 'g1', supported: true,
    cleanup_failed: true, recovering: false, last_report: null, ...overrides };
}
const recovered = { status: 'recovered', coverage: 'plugin', inspected: 2, remaining: 0,
  message: '已确认全部资源', checks: [{ resource: 'control', status: 'confirmed', message: '控制资源已释放' }] };

function fixture(transport: typeof fetch) {
  const model = createPluginRecovery(createApiClient({ baseUrl: 'http://localhost', transport }), 'mirroring');
  model.setTarget({ key: 'device-a:g1', deviceId: 'device-a' });
  return model;
}

test('未发布操作目录时仍能恢复，手动提交前 GET 最新代际，只 POST 一次', async (t) => {
  const calls: string[] = [];
  let generation = 'g1';
  const model = fixture(async (input, init) => {
    assert.equal(requestUrl(input).pathname, '/api/v2/plugins/mirroring/recovery');
    calls.push(init?.method ?? '');
    if (init?.method === 'GET') return success(view({ generation }), 'read-log');
    assert.deepEqual(JSON.parse(String(init?.body)), { generation: 'g2', input: { device_id: 'device-a' } });
    return success(view({ generation, cleanup_failed: false, last_report: recovered }), 'recover-log');
  });
  t.after(() => model.dispose());
  await model.refresh(signal());
  generation = 'g2';
  await model.recover(signal());
  assert.deepEqual(calls, ['GET', 'GET', 'POST']);
  assert.equal(model.snapshot().result?.data.generation, 'g2');
  assert.equal(model.snapshot().result?.logId, 'recover-log');
  assert.equal(model.snapshot().reportTarget, 'device-a:g1');
});

test('未选设备时使用插件级目标，GET 可读且 POST 空输入核对全插件台账', async (t) => {
  const calls: { method: string; body: unknown }[] = [];
  const model = fixture(async (_, init) => {
    calls.push({ method: init?.method ?? '', body: init?.body ? JSON.parse(String(init.body)) : null });
    return success(view(init?.method === 'POST' ? { cleanup_failed: false, last_report: recovered } : {}));
  });
  t.after(() => model.dispose());
  model.setTarget({ key: 'plugin:mirroring' });
  await model.refresh(signal());
  assert.equal(model.snapshot().result?.data.supported, true);
  await model.recover(signal());
  assert.deepEqual(calls, [
    { method: 'GET', body: null }, { method: 'GET', body: null },
    { method: 'POST', body: { generation: 'g1', input: {} } },
  ]);
  assert.equal(model.snapshot().target?.deviceId, undefined);
  assert.equal(model.snapshot().reportTarget, 'plugin:mirroring');
});

test('清空设备选择切到全插件时取消设备恢复等待，旧结果不写回全插件目标', async (t) => {
  const entered = deferred<void>();
  const delayed = deferred<Response>();
  let posts = 0;
  const model = fixture(async (_, init) => {
    if (init?.method === 'POST') { ++posts; entered.resolve(); return delayed.promise; }
    return success(view(), 'plugin-read-log');
  });
  t.after(() => model.dispose());
  const waiting = model.recover(signal());
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  model.setTarget({ key: 'plugin:mirroring' });
  await model.refresh(signal());
  delayed.resolve(success(view({ cleanup_failed: false, last_report: recovered }), 'old-device-log'));
  await rejected;
  assert.equal(model.snapshot().target?.key, 'plugin:mirroring');
  assert.equal(model.snapshot().target?.deviceId, undefined);
  assert.equal(model.snapshot().result?.logId, 'plugin-read-log');
  assert.equal(model.snapshot().reportTarget, null);
  assert.equal(posts, 1);
});

test('正常打开前只 GET 一次，不自动 POST，已有历史 blocked 报告交宿主核对', async (t) => {
  const methods: (string | undefined)[] = [];
  const model = fixture(async (_, init) => {
    methods.push(init?.method);
    return success(view({ last_report: { ...recovered, status: 'blocked', remaining: 1,
      checks: [{ resource: 'control', status: 'blocked', message: '上次未确认' }] } }));
  });
  t.after(() => model.dispose());
  await model.prepareOpen(signal());
  assert.deepEqual(methods, ['GET']);
});

test('辅助恢复 GET 网络失败不额外封锁正常打开，失败状态仍保留且不提交恢复', async (t) => {
  let reads = 0;
  const model = fixture(async (_, init) => {
    assert.equal(init?.method, 'GET');
    ++reads;
    throw new Error('恢复查询网络失败');
  });
  t.after(() => model.dispose());
  await model.prepareOpen(signal());
  assert.equal(reads, 1);
  assert.equal(model.snapshot().result, null);
  const error = model.snapshot().error;
  assert.ok(error instanceof ApiError);
  assert.equal(error.kind, 'network');
});

test('已有状态 GET 时打开准备撤销旧等待、不叠加查询，切目标后旧结果不回写', async (t) => {
  const entered = deferred<void>();
  const delayed = deferred<Response>();
  let reads = 0;
  const model = fixture(async (_, init) => {
    assert.equal(init?.method, 'GET');
    ++reads;
    entered.resolve();
    return delayed.promise;
  });
  t.after(() => model.dispose());
  const waiting = model.refresh(signal());
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  await model.prepareOpen(signal());
  await rejected;
  assert.equal(model.snapshot().phase, 'idle');
  assert.equal(reads, 1);
  model.setTarget(null);
  delayed.resolve(success(view()));
  await rejected;
  assert.equal(model.snapshot().target, null);
});

test('恢复快照为 recovering 不阻断打开，只读一次且不重复 POST', async (t) => {
  let reads = 0;
  const model = fixture(async (_, init) => {
    assert.equal(init?.method, 'GET');
    ++reads;
    return success(view({ recovering: true }), 'busy-log');
  });
  t.after(() => model.dispose());
  await model.recover(signal());
  assert.equal(model.snapshot().result?.data.recovering, true);
  await model.prepareOpen(signal());
  assert.equal(model.snapshot().result?.logId, 'busy-log');
  assert.equal(reads, 2);
});

for (const posting of [false, true]) {
  test(`打开准备撤销旧恢复${posting ? 'POST' : 'GET'}本地等待，晚到结果不回写、不追加全局核对`, async (t) => {
    const entered = deferred<void>();
    const delayed = deferred<Response>();
    const methods: (string | undefined)[] = [];
    const model = fixture(async (_, init) => {
      methods.push(init?.method);
      if (!posting || init?.method === 'POST') { entered.resolve(); return delayed.promise; }
      return success(view(), 'before-open-log');
    });
    t.after(() => model.dispose());
    const waiting = model.recover(signal());
    const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    await entered.promise;
    await model.prepareOpen(signal());
    await rejected;
    assert.equal(model.snapshot().phase, 'idle');
    const current = model.snapshot();
    delayed.resolve(success(view({ recovering: true, last_report: recovered }), 'old-recovery-log'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(model.snapshot(), current);
    assert.deepEqual(methods, posting ? ['GET', 'POST'] : ['GET']);
  });
}

test('POST busy 视图与未确认数保留，只有用户再次点击才发起下一次恢复', async (t) => {
  let posts = 0;
  const model = fixture(async (_, init) => {
    if (init?.method === 'GET') return success(view());
    ++posts;
    return success(view({ last_report: { ...recovered, status: 'busy', remaining: 3,
      checks: [{ resource: 'session', status: 'busy', message: '其他客户端正在观看' }] } }));
  });
  t.after(() => model.dispose());
  await model.recover(signal());
  assert.equal(posts, 1);
  assert.equal(model.snapshot().result?.data.last_report?.remaining, 3);
  assert.equal(model.snapshot().result?.data.last_report?.status, 'busy');
});

test('恢复 GET 不支持时不提交；旧宿主 404 保留日志，打开仍走原入口', async (t) => {
  let oldHost = false;
  const model = fixture(async (_, init) => {
    assert.equal(init?.method, 'GET');
    return oldHost ? failure('not_found', 404) : success(view({ supported: false }));
  });
  t.after(() => model.dispose());
  await model.recover(signal());
  assert.equal(model.snapshot().result?.data.supported, false);
  oldHost = true;
  await model.prepareOpen(signal());
  assert.equal(model.snapshot().unavailable, true);
  const error = model.snapshot().error;
  assert.ok(error instanceof ApiError);
  assert.equal(error.logId, 'log-error');
});

test('代际冲突后只 GET 重查，不重发 POST，保留原始冲突日志', async (t) => {
  const methods: (string | undefined)[] = [];
  let posts = 0;
  const model = fixture(async (_, init) => {
    methods.push(init?.method);
    if (init?.method === 'POST') { ++posts; return failure('conflict'); }
    return success(view({ generation: posts ? 'g2' : 'g1' }), 'new-generation-log');
  });
  t.after(() => model.dispose());
  await assert.rejects(model.recover(signal()), (error: unknown) => error instanceof ApiError && error.logId === 'log-error');
  assert.deepEqual(methods, ['GET', 'POST', 'GET']);
  assert.equal(model.snapshot().result?.data.generation, 'g2');
  assert.equal(model.snapshot().reportTarget, null);
  assert.ok(model.snapshot().error instanceof ApiError);
});

test('插件身份及 POST 代际不匹配拒绝，不能把其他插件恢复结果当成功', async (t) => {
  let wrongId = true;
  const model = fixture(async (_, init) => success(wrongId ? view({ id: 'other' })
    : view({ generation: init?.method === 'POST' ? 'g2' : 'g1', last_report: recovered }), 'identity-log'));
  t.after(() => model.dispose());
  await assert.rejects(model.refresh(signal()), (error: unknown) => error instanceof ApiError && error.logId === 'identity-log');
  wrongId = false;
  await assert.rejects(model.recover(signal()), (error: unknown) => error instanceof ApiError && error.kind === 'protocol');
  assert.equal(model.snapshot().reportTarget, null);
});

test('切设备取消旧 GET，迟到成功不覆盖新目标，也不提交旧设备 POST', async (t) => {
  const entered = deferred<void>();
  const delayed = deferred<Response>();
  let reads = 0;
  const model = fixture(async (_, init) => {
    assert.equal(init?.method, 'GET');
    if (++reads === 1) { entered.resolve(); return delayed.promise; }
    return success(view({ generation: 'g2' }), 'new-device-log');
  });
  t.after(() => model.dispose());
  const old = model.recover(signal());
  const rejection = assert.rejects(old, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  model.setTarget({ key: 'device-b:g2', deviceId: 'device-b' });
  await model.refresh(signal());
  delayed.resolve(success(view(), 'late-log'));
  await rejection;
  assert.equal(model.snapshot().target?.deviceId, 'device-b');
  assert.equal(model.snapshot().result?.logId, 'new-device-log');
  assert.equal(model.snapshot().reportTarget, null);
});

test('取消已提交 POST 后只读一次真实状态，不重发，晚到恢复不覆盖状态', async (t) => {
  const entered = deferred<void>();
  const delayed = deferred<Response>();
  const reread = deferred<void>();
  let reads = 0;
  let posts = 0;
  const model = fixture(async (_, init) => {
    if (init?.method === 'POST') { ++posts; entered.resolve(); return delayed.promise; }
    ++reads;
    if (reads === 2) reread.resolve();
    return success(view({ recovering: reads === 2 }), `read-${reads}`);
  });
  t.after(() => model.dispose());
  const waiting = model.recover(signal());
  const rejection = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  model.cancel();
  await rejection;
  await reread.promise;
  for (let i = 0; i < 12 && model.snapshot().phase !== 'idle'; ++i) await new Promise<void>((resolve) => setImmediate(resolve));
  delayed.resolve(success(view({ cleanup_failed: false, last_report: recovered }), 'late-post-log'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(posts, 1);
  assert.equal(reads, 2);
  assert.equal(model.snapshot().cancelled, true);
  assert.equal(model.snapshot().result?.data.recovering, true);
  assert.equal(model.snapshot().reportTarget, null);
});

test('外部信号取消恢复会重查一次；并发调用和销毁不会生成恢复重试', async (t) => {
  const entered = deferred<void>();
  const delayed = deferred<Response>();
  let posts = 0;
  let reads = 0;
  const model = fixture(async (_, init) => {
    if (init?.method === 'POST') { ++posts; entered.resolve(); return delayed.promise; }
    ++reads;
    return success(view());
  });
  t.after(() => model.dispose());
  const controller = new AbortController();
  const waiting = model.recover(controller.signal);
  const rejection = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  await assert.rejects(model.recover(signal()), (error: unknown) => error instanceof ApiError && error.code === 'busy');
  controller.abort();
  await rejection;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  model.dispose();
  delayed.resolve(success(view({ cleanup_failed: false, last_report: recovered })));
  assert.equal(posts, 1);
  await assert.rejects(model.refresh(signal()), (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
});

test('取消失败后的回读不会再次叠加 GET，旧错误不会回写取消后的状态', async (t) => {
  const entered = deferred<void>();
  const delayed = deferred<Response>();
  let reads = 0;
  let posts = 0;
  const model = fixture(async (_, init) => {
    if (init?.method === 'POST') { ++posts; return failure('conflict'); }
    if (++reads === 2) { entered.resolve(); return delayed.promise; }
    return success(view());
  });
  t.after(() => model.dispose());
  const waiting = model.recover(signal());
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.code === 'conflict');
  await entered.promise;
  model.cancel();
  await rejected;
  delayed.resolve(success(view({ generation: 'g2' })));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(posts, 1);
  assert.equal(model.snapshot().cancelled, true);
  assert.equal(model.snapshot().error, null);
  assert.equal(model.snapshot().result, null);
});

test('重读报告不继续标记为本次设备 POST，避免误认其他客户端的新报告', async (t) => {
  const model = fixture(async () => success(view({ cleanup_failed: false, last_report: recovered })));
  t.after(() => model.dispose());
  await model.recover(signal());
  assert.equal(model.snapshot().reportTarget, 'device-a:g1');
  await model.refresh(signal());
  assert.equal(model.snapshot().reportTarget, null);
});

test('网络失败及损坏报告不会清除风险或追加 POST，错误重查不覆盖原始错误', async (t) => {
  let posts = 0;
  let reads = 0;
  const model = fixture(async (_, init) => {
    if (init?.method === 'POST') { ++posts; return success(view({ last_report: { ...recovered, remaining: 2 } }), 'bad-report-log'); }
    if (++reads > 1) throw new Error('重查网络失败');
    return success(view());
  });
  t.after(() => model.dispose());
  await assert.rejects(model.recover(signal()), (error: unknown) => error instanceof ApiError && error.logId === 'bad-report-log');
  assert.equal(model.snapshot().result, null);
  assert.equal(posts, 1);
  assert.equal(reads, 2);
  const error = model.snapshot().error;
  assert.ok(error instanceof ApiError);
  assert.equal(error.logId, 'bad-report-log');
});
