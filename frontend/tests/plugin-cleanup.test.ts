import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/services/api/index.ts';
import type { ClientOptions } from '../src/services/api/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { CleanupContext, Dispose, HostContext } from '../src/plugin-sdk/index.ts';
import { createPluginCleanup } from '../src/app/plugin-cleanup.ts';
import { createPluginTransport } from '../src/app/plugin-transport.ts';
import { scopedTransportAccess } from '../src/plugins/transport-access.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { success } from './fixtures.ts';

function fixture(timeoutMs = 50, request: NonNullable<ClientOptions['transport']> = async () => success({ released: true })) {
  const owner = new AbortController(), registrations = new Set<Dispose>();
  function track(dispose: Dispose): Dispose {
    let released = false;
    const release = () => {
      if (released) return;
      released = true; registrations.delete(release); return dispose();
    };
    registrations.add(release); return release;
  }
  const transport = createPluginTransport(createApiClient({ baseUrl: 'http://127.0.0.1:7031', transport: request }));
  const unavailable = () => { throw new Error('本单元不使用任务接口'); };
  const host: HostContext = {
    apiVersion: 2, signal: owner.signal, onDispose: track,
    onCleanup: createPluginCleanup({ signal: owner.signal, onDispose: track, transport, timeoutMs }),
    transport: scopedTransportAccess(transport, owner.signal, track),
    listOperations: async () => ({ data: [], logId: null }), subscribeOperations: () => () => {},
    submit: unavailable, getJob: unavailable, cancelJob: unavailable,
  };
  return { host, owner, registrations, async dispose() {
    owner.abort(); await Promise.all([...registrations].map((release) => release()));
  } };
}

test('普通请求随作用域撤销，已登记清理仍用独立信号释放且保留原日志', async () => {
  let calls = 0;
  const f = fixture(100, async (_url, init) => {
    calls++; assert.equal(init?.signal?.aborted, false); return success({ released: true }, 'cleanup-log');
  });
  const scope = createPluginScope(f.host), observations: CleanupContext[] = [];
  assert.ok(scope.context.onCleanup);
  scope.context.onCleanup(async (cleanup) => {
    observations.push(cleanup);
    assert.equal(scope.context.signal.aborted, true);
    assert.equal(cleanup.signal.aborted, false);
    assert.ok(cleanup.deadline >= Date.now());
    assert.ok(cleanup.transport);
    assert.deepEqual(await cleanup.transport.request({ path: '/api/v2/owned/release', method: 'POST' }, cleanup.signal), {
      data: { released: true }, logId: 'cleanup-log',
    });
  });
  try {
    await scope.dispose();
    assert.equal(calls, 1);
    assert.equal(f.registrations.size, 0);
    assert.ok(scope.context.transport);
    await assert.rejects(scope.context.transport.request({ path: '/api/v2/owned/new' }, new AbortController().signal));
    const observed = observations[0]; assert.ok(observed?.transport);
    assert.equal(observed.signal.aborted, true);
    await assert.rejects(observed.transport.request({ path: '/api/v2/owned/new' }, new AbortController().signal));
    assert.equal(calls, 1, '清理完成后泄漏的请求句柄不能继续派发');
  } finally { await f.dispose(); }
});

test('手动释放和卸载共享一次回调，已完成清理不留在根资源列表', async () => {
  const f = fixture(), scope = createPluginScope(f.host);
  let calls = 0; assert.ok(scope.context.onCleanup);
  const release = scope.context.onCleanup(() => { calls++; });
  await release(); await release(); await scope.dispose();
  assert.equal(calls, 1); assert.equal(f.registrations.size, 0);
  await f.dispose();
});

test('嵌套功能的清理错误归属最近作用域，不被祖先吞掉或污染根', async () => {
  const f = fixture(), parent = createPluginScope(f.host), feature = createPluginScope(parent.context);
  const original = new HostError('http', 'release_unknown', '释放结果未确认', 'release-log', 503, '2');
  assert.ok(feature.context.onCleanup);
  feature.context.onCleanup(() => { throw original; });
  await assert.rejects(feature.dispose(), (error) => error instanceof AggregateError && error.errors[0] === original);
  assert.equal(f.registrations.size, 0);
  await parent.dispose(); await f.dispose();
});

test('清理不返回时按预算结束，旧失败不阻止另一个作用域的新资源', async () => {
  const f = fixture(15), first = createPluginScope(f.host), contexts: CleanupContext[] = [];
  let attempts = 0; assert.ok(first.context.onCleanup);
  first.context.onCleanup((cleanup) => {
    attempts++; contexts.push(cleanup); return new Promise<void>(() => {});
  });
  await assert.rejects(first.dispose(), (error) => error instanceof AggregateError && error.errors.some(
    (item: unknown) => item instanceof HostError && item.code === 'plugin_lifecycle_timeout'));
  assert.equal(attempts, 1); assert.equal(contexts[0]?.signal.aborted, true);
  const next = createPluginScope(f.host); assert.ok(next.context.onCleanup);
  let released = false; next.context.onCleanup(() => { released = true; });
  await next.dispose(); assert.equal(released, true);
  await f.dispose();
});

test('清理请求错误保留状态与退避信息，未知释放不会自动重放', async () => {
  let calls = 0;
  const f = fixture(100, async () => {
    calls++;
    return Response.json({ log_id: 'unknown-log', error: { code: 'release_unknown', message: '需重新查询' } }, {
      status: 503, headers: { 'x-deviceforge-log-id': 'unknown-log', 'retry-after': '4' },
    });
  });
  const scope = createPluginScope(f.host); assert.ok(scope.context.onCleanup);
  scope.context.onCleanup(async (cleanup) => {
    assert.ok(cleanup.transport);
    await cleanup.transport.request({ path: '/api/v2/owned/release', method: 'POST' }, cleanup.signal);
  });
  await assert.rejects(scope.dispose(), (error) => error instanceof AggregateError && error.errors.some(
    (item: unknown) => item instanceof HostError && item.code === 'release_unknown' &&
      item.logId === 'unknown-log' && item.status === 503 && item.retryAfter === '4'));
  assert.equal(calls, 1); await f.dispose();
});

test('撤销后拒绝新增清理登记，旧SDK宿主不被假装具备该能力', async () => {
  const f = fixture(), scope = createPluginScope(f.host);
  scope.close(); assert.ok(scope.context.onCleanup);
  assert.throws(() => scope.context.onCleanup?.(() => {}), (error: unknown) =>
    error instanceof HostError && error.code === 'cleanup_owner_revoked');
  f.owner.abort(); assert.throws(() => f.host.onCleanup?.(() => {}));
  const legacyFixture = fixture();
  const { onCleanup: omitted, ...legacy } = legacyFixture.host; void omitted;
  const old = createPluginScope(legacy);
  assert.equal(old.context.onCleanup, undefined);
  await old.dispose(); await legacyFixture.dispose(); await scope.dispose(); await f.dispose();
});
