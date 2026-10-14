import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { createOperations } from '../src/features/operations/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { OperationDto } from '../src/services/api/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import {
  deferred,
  failure,
  installedPackage,
  plugin,
  requestUrl,
  signal,
  success,
} from './fixtures.ts';

const operation = (id: string): OperationDto => ({ id, title: '动态操作', input_schema: {} });
const cancelled = (error: unknown) => error instanceof ApiError && error.kind === 'cancelled';

test('操作失效撤销独立列表及刷新旧请求，晚到响应不能复活目录，新刷新可恢复', async () => {
  const oldRefresh = deferred<Response>();
  const oldList = deferred<Response>();
  const entered = deferred<void>();
  const requestSignals: AbortSignal[] = [];
  let requests = 0;
  const operations = createOperations(
    createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async (_url, init) => {
        assert.ok(init?.signal);
        requestSignals.push(init.signal);
        ++requests;
        if (requests === 1) return success([operation('old.run')], 'old-log');
        if (requests === 2) return oldRefresh.promise;
        if (requests === 3) {
          entered.resolve();
          return oldList.promise;
        }
        return success([operation('new.run')], 'new-log');
      },
    }),
  );
  await operations.refresh(signal());
  const observed: string[][] = [];
  operations.subscribe(() => {
    throw new Error('坏订阅不能阻止撤销');
  });
  operations.subscribe((snapshot) => {
    if (snapshot.result) observed.push(snapshot.result.data.map((item) => item.id));
  });
  const refreshing = operations.refresh(signal());
  const listing = operations.list(signal());
  const refreshRejected = assert.rejects(refreshing, cancelled);
  const listRejected = assert.rejects(listing, cancelled);
  await entered.promise;
  operations.invalidate();
  assert.deepEqual(operations.snapshot().result?.data, []);
  assert.equal(operations.snapshot().result?.logId, null);
  assert.equal(operations.snapshot().pending, false);
  assert.deepEqual(observed.at(-1), []);
  assert.equal(requestSignals[1]?.aborted, true);
  assert.equal(requestSignals[2]?.aborted, true);
  await Promise.all([refreshRejected, listRejected]);
  const recovered = await operations.refresh(signal());
  assert.equal(recovered.logId, 'new-log');
  oldRefresh.resolve(success([operation('stale.refresh')], 'stale-log'));
  oldList.resolve(success([operation('stale.list')], 'stale-log'));
  await Promise.all([oldRefresh.promise, oldList.promise]);
  assert.deepEqual(
    operations.snapshot().result?.data.map((item) => item.id),
    ['new.run'],
  );
  assert.ok(observed.every((items) => !items.some((id) => id.startsWith('stale.'))));
  operations.dispose();
});

test('失效后重查失败保留空目录和真实错误日志，取消也不恢复旧目录', async () => {
  const pending = deferred<Response>();
  const entered = deferred<void>();
  let requests = 0;
  const operations = createOperations(
    createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async () => {
        ++requests;
        if (requests === 1) return success([operation('old.run')], 'old-log');
        if (requests === 2) return failure('dependency_failed', 502);
        if (requests === 3) {
          entered.resolve();
          return pending.promise;
        }
        return success([operation('recovered.run')], 'recovered-log');
      },
    }),
  );
  await operations.refresh(signal());
  operations.invalidate();
  await assert.rejects(operations.refresh(signal()), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'dependency_failed');
    assert.equal(error.logId, 'log-error');
    return true;
  });
  assert.deepEqual(operations.snapshot().result?.data, []);
  assert.equal(operations.snapshot().result?.logId, null);
  const failureState = operations.snapshot().error;
  assert.ok(failureState instanceof ApiError);
  assert.equal(failureState.code, 'dependency_failed');
  const cancellation = new AbortController();
  const refreshing = operations.refresh(cancellation.signal);
  const rejected = assert.rejects(refreshing, cancelled);
  await entered.promise;
  cancellation.abort();
  await rejected;
  pending.resolve(success([operation('cancelled.run')]));
  await pending.promise;
  assert.deepEqual(operations.snapshot().result?.data, []);
  assert.equal(operations.snapshot().pending, false);
  await operations.refresh(signal());
  assert.deepEqual(
    operations.snapshot().result?.data.map((item) => item.id),
    ['recovered.run'],
  );
  operations.dispose();
});

test('替代刷新拒绝旧响应，销毁后不能继续查询、订阅或失效', async () => {
  const old = deferred<Response>();
  const entered = deferred<void>();
  let requests = 0;
  const operations = createOperations(
    createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async () => {
        ++requests;
        if (requests === 1) {
          entered.resolve();
          return old.promise;
        }
        return success([operation('current.run')]);
      },
    }),
  );
  const first = operations.refresh(signal());
  const firstRejected = assert.rejects(first, cancelled);
  await entered.promise;
  await operations.refresh(signal());
  await firstRejected;
  old.resolve(success([operation('old.run')]));
  await old.promise;
  assert.deepEqual(
    operations.snapshot().result?.data.map((item) => item.id),
    ['current.run'],
  );
  operations.dispose();
  await assert.rejects(operations.refresh(signal()), cancelled);
  await assert.rejects(operations.list(signal()), cancelled);
  assert.throws(() => operations.invalidate(), cancelled);
  assert.throws(() => operations.subscribe(() => {}), cancelled);
  assert.deepEqual(operations.snapshot().result?.data, []);
});

const managementScenarios: readonly {
  title: string;
  outcome: 'success' | 'failure' | 'cancel';
  throughPackages: boolean;
}[] = [
  { title: '卸载成功', outcome: 'success', throughPackages: false },
  { title: '卸载被拒绝', outcome: 'failure', throughPackages: false },
  { title: '取消卸载等待', outcome: 'cancel', throughPackages: false },
  { title: '在线包服务器停用', outcome: 'success', throughPackages: true },
];
for (const scenario of managementScenarios) {
  test(`${scenario.title}收敛时通知 SDK 空目录，重查失败不复活旧查询且不重放管理`, async (t) => {
    const oldRefresh = deferred<Response>();
    const oldList = deferred<Response>();
    const oldQueriesEntered = deferred<void>();
    const managementEntered = deferred<void>();
    const managementResponse = deferred<Response>();
    const recheckEntered = deferred<void>();
    const recheck = deferred<Response>();
    let operationRequests = 0;
    let managementPosts = 0;
    const runtime = createFrontendRuntime({
      baseUrl: 'http://localhost:7031',
      panelTarget: () => null,
      transport: async (url, init) => {
        const path = requestUrl(url).pathname;
        if (path === '/api/v2/operations') {
          ++operationRequests;
          if (operationRequests === 1) return success([operation('legacy.run')], 'seed-log');
          if (operationRequests === 2) return oldRefresh.promise;
          if (operationRequests === 3) {
            oldQueriesEntered.resolve();
            return oldList.promise;
          }
          if (operationRequests === 4) {
            recheckEntered.resolve();
            return recheck.promise;
          }
          return success([operation('plugin.current.run')], 'current-log');
        }
        if (path.endsWith('/unload')) {
          ++managementPosts;
          managementEntered.resolve();
          return managementResponse.promise;
        }
        if (path === '/api/v2/plugins')
          return success(
            scenario.outcome === 'success'
              ? []
              : [plugin({ state: 'draining', cleanup_failed: true })],
          );
        if (path === '/api/v2/plugin-packages/server') return success([installedPackage('server')]);
        if (path === '/api/v2/device-providers' || path === '/api/v2/devices') return success([]);
        throw new Error('测试出现未预期端点');
      },
    });
    t.after(() => runtime.dispose());
    const sdkNotices: string[][] = [];
    runtime.host.subscribeOperations((items) => {
      sdkNotices.push(items.map((item) => item.id));
    });
    await runtime.operations.refresh(signal());
    assert.deepEqual(sdkNotices, [['legacy.run']]);
    const refreshing = runtime.operations.refresh(signal());
    const listing = runtime.host.listOperations(signal());
    const refreshRejected = assert.rejects(refreshing, cancelled);
    const listRejected = assert.rejects(
      listing,
      (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
    );
    await oldQueriesEntered.promise;
    const caller = new AbortController();
    const managing = scenario.throughPackages
      ? runtime.pluginPackages.disable('server', 'example', caller.signal)
      : runtime.serverPlugins.unload('example', caller.signal);
    const managementRejected = assert.rejects(managing, (error: unknown) => {
      if (scenario.outcome === 'success') return error instanceof AggregateError;
      assert.ok(error instanceof ApiError);
      assert.equal(error.logId, scenario.outcome === 'failure' ? 'log-error' : null);
      return scenario.outcome === 'failure'
        ? error.code === 'cleanup_failed'
        : error.kind === 'cancelled';
    });
    await managementEntered.promise;
    if (scenario.outcome === 'cancel') caller.abort();
    else
      managementResponse.resolve(
        scenario.outcome === 'success'
          ? success(plugin({ state: 'unloaded' }))
          : failure('cleanup_failed'),
      );
    await recheckEntered.promise;
    assert.deepEqual(sdkNotices.at(-1), []);
    assert.deepEqual(runtime.operations.snapshot().result?.data, []);
    assert.equal(runtime.operations.snapshot().result?.logId, null);
    await Promise.all([refreshRejected, listRejected]);
    recheck.resolve(failure('dependency_failed', 502));
    await managementRejected;
    if (scenario.outcome === 'cancel')
      managementResponse.resolve(success(plugin({ state: 'unloaded' })));
    assert.equal(managementPosts, 1);
    assert.equal(runtime.operations.snapshot().pending, false);
    const errorState = runtime.operations.snapshot().error;
    assert.ok(errorState instanceof ApiError);
    assert.equal(errorState.logId, 'log-error');
    assert.deepEqual(runtime.operations.snapshot().result?.data, []);
    await runtime.operations.refresh(signal());
    oldRefresh.resolve(success([operation('stale.refresh')], 'stale-log'));
    oldList.resolve(success([operation('stale.list')], 'stale-log'));
    await Promise.all([oldRefresh.promise, oldList.promise]);
    assert.deepEqual(sdkNotices.at(-1), ['plugin.current.run']);
    assert.equal(runtime.operations.snapshot().result?.logId, 'current-log');
    assert.ok(sdkNotices.every((items) => !items.some((id) => id.startsWith('stale.'))));
  });
}

test('操作目录失效通知订阅时可重入，新刷新不被旧请求的结束回写', async () => {
  let requests = 0;
  const operations = createOperations(
    createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async () => {
        ++requests;
        return success([operation('current.run')]);
      },
    }),
  );
  let invalidateOnPending = true;
  operations.subscribe((snapshot) => {
    if (snapshot.pending && invalidateOnPending) {
      invalidateOnPending = false;
      operations.invalidate();
    }
  });
  await assert.rejects(operations.refresh(signal()), cancelled);
  assert.equal(requests, 0);
  assert.deepEqual(operations.snapshot().result?.data, []);
  await operations.refresh(signal());
  assert.equal(requests, 1);
  assert.deepEqual(
    operations.snapshot().result?.data.map((item) => item.id),
    ['current.run'],
  );
  operations.dispose();
});

test('管理成功重查恢复新目录，SDK 按旧目录、撤销、新目录顺序收到通知', async (t) => {
  let loaded = false;
  let posts = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (url, init) => {
      const path = requestUrl(url).pathname;
      if (path.endsWith('/load')) {
        assert.equal(init?.method, 'POST');
        ++posts;
        loaded = true;
        return success(plugin());
      }
      if (path === '/api/v2/operations')
        return success(
          [operation(loaded ? 'plugin.new.run' : 'legacy.run')],
          loaded ? 'loaded-log' : 'before-log',
        );
      if (path === '/api/v2/plugins') return success([plugin()]);
      if (path === '/api/v2/device-providers' || path === '/api/v2/devices') return success([]);
      throw new Error('测试出现未预期端点');
    },
  });
  t.after(() => runtime.dispose());
  const seen: string[][] = [];
  const release = runtime.host.subscribeOperations((items) => {
    seen.push(items.map((item) => item.id));
  });
  await runtime.operations.refresh(signal());
  await runtime.serverPlugins.load('example', signal());
  assert.deepEqual(seen, [['legacy.run'], [], ['plugin.new.run']]);
  assert.equal(posts, 1);
  assert.equal(runtime.operations.snapshot().result?.logId, 'loaded-log');
  await release();
  runtime.operations.invalidate();
  assert.deepEqual(seen, [['legacy.run'], [], ['plugin.new.run']]);
});

test('订阅重入撤销刚成功的响应时，其余订阅和调用者均不能收到旧目录', async () => {
  const operations = createOperations(
    createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async () => success([operation('revoked.run')]),
    }),
  );
  let invalidateOnce = true;
  const seen: string[][] = [];
  operations.subscribe((snapshot) => {
    if (!snapshot.pending && snapshot.result?.data.length && invalidateOnce) {
      invalidateOnce = false;
      operations.invalidate();
    }
  });
  operations.subscribe((snapshot) => {
    if (!snapshot.pending && snapshot.result)
      seen.push(snapshot.result.data.map((item) => item.id));
  });
  await assert.rejects(operations.refresh(signal()), cancelled);
  assert.deepEqual(seen, [[]]);
  assert.deepEqual(operations.snapshot().result?.data, []);
  operations.dispose();
});
