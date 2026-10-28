import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DeviceAccess, DeviceAction } from '../src/plugin-sdk/index.ts';
import {
  ApiError,
  createApiClient,
  deviceDirectoriesEndpoint,
  deviceProvidersEndpoint,
  refreshDeviceProviderEndpoint,
} from '../src/services/api/index.ts';
import type { DeviceDirectoryDto } from '../src/services/api/index.ts';
import { directory, provider } from './device-fixtures.ts';
import { deferred, failure, job, plugin, requestUrl, signal, success } from './fixtures.ts';

function action(overrides: Partial<DeviceAction> = {}): DeviceAction {
  return {
    providerId: 'example',
    generation: 'g1',
    deviceId: 'same',
    capability: 'read',
    version: 1,
    input: {},
    ...overrides,
  };
}
function deviceHost(value: DeviceAccess | undefined): DeviceAccess {
  assert.ok(value);
  return value;
}

test('四设备端点显式映射 SDK，跨提供者同名设备可独立选择，动作返回共享 Job 与日志', async () => {
  const requests: string[] = [];
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input, init) => {
      const url = requestUrl(input);
      requests.push(`${init?.method} ${url.pathname}`);
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      if (url.pathname === '/api/v2/device-providers')
        return success([provider('first'), provider('second')], 'providers-log');
      if (url.pathname === '/api/v2/devices')
        return success([directory('first'), directory('second')], 'directories-log');
      if (url.pathname.endsWith('/refresh')) {
        assert.equal(init?.body, JSON.stringify({ generation: 'g1' }));
        return success(directory('second'), 'refresh-log');
      }
      assert.equal(url.pathname, '/api/v2/device-actions');
      assert.equal(
        init?.body,
        JSON.stringify({
          provider_id: 'first',
          generation: 'g1',
          device_id: 'same',
          capability: 'read',
          version: 1,
          input: { value: 3 },
        }),
      );
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
      return success(job('device-job'), 'action-log', 202);
    },
  });
  const host = deviceHost(runtime.host.devices);
  assert.equal(runtime.host.apiVersion, 2);
  assert.equal((await host.refreshProviders(signal())).logId, 'providers-log');
  const result = await host.refreshDirectories(signal());
  assert.equal(result.logId, 'directories-log');
  assert.equal(result.data[0]?.provider.definition.apiVersion, 1);
  assert.equal(result.data[0]?.provider.definition.discoverOperation, 'first.discover');
  assert.equal(result.data[0]?.devices[0]?.reference.providerId, 'first');
  assert.equal(result.data[1]?.devices[0]?.reference.localId, 'same');
  runtime.devices.select({ providerId: 'first', generation: 'g1', localId: 'same' });
  assert.equal(runtime.devices.snapshot().selected?.reference.providerId, 'first');
  runtime.devices.select({ providerId: 'second', generation: 'g1', localId: 'same' });
  assert.equal(runtime.devices.snapshot().selected?.reference.providerId, 'second');
  assert.equal((await host.refreshProvider('second', 'g1', signal())).logId, 'refresh-log');
  const invoked = await host.invoke(action({ providerId: 'first', input: { value: 3 } }), signal());
  assert.equal(invoked.logId, 'action-log');
  assert.equal(invoked.data.id, 'device-job');
  assert.equal(invoked.data.result, null);
  assert.ok(requests.includes('POST /api/v2/device-providers/second/refresh'));
  await runtime.dispose();
});

test('选设备后旧动作晚到不回写，切换身份及时取消旧等待，当前选择保持新设备', async () => {
  const response = deferred<Response>();
  const started = deferred<AbortSignal | null | undefined>();
  let results = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input, init) => {
      if (requestUrl(input).pathname === '/api/v2/device-actions') {
        started.resolve(init?.signal);
        return response.promise;
      }
      return success(
        requestUrl(input).pathname.endsWith('device-providers')
          ? [provider()]
          : [directory('example', 'g1', ['same', 'other'])],
      );
    },
  });
  await runtime.devices.refreshDirectories(signal());
  runtime.devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
  const waiting = runtime.devices.invoke(action(), signal()).then((value) => {
    ++results;
    return value;
  });
  const rejected = assert.rejects(
    waiting,
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  const combined = await started.promise;
  runtime.devices.select({ providerId: 'example', generation: 'g1', localId: 'other' });
  assert.equal(combined?.aborted, true);
  await rejected;
  response.resolve(success(job('late')));
  assert.equal(results, 0);
  assert.equal(runtime.devices.snapshot().selected?.reference.localId, 'other');
  await runtime.dispose();
});

test('提供者刷新在途立即撤销旧观测和选择，失败不恢复，成功按清理后修订发布', async () => {
  const response = deferred<Response>();
  const started = deferred<void>();
  let late = true;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/refresh')) {
        if (late) {
          started.resolve();
          return response.promise;
        }
        return success(directory(), 'new-observation');
      }
      return success(path.endsWith('device-providers') ? [provider()] : [directory()]);
    },
  });
  await runtime.devices.refreshDirectories(signal());
  runtime.devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
  const waiting = runtime.devices.refreshProvider('example', 'g1', signal());
  const rejected = assert.rejects(
    waiting,
    (error: unknown) =>
      error instanceof HostError &&
      error.code === 'dependency_failed' &&
      error.logId === 'log-error',
  );
  await started.promise;
  assert.deepEqual(runtime.devices.snapshot().directories, []);
  assert.equal(runtime.devices.snapshot().selection, null);
  assert.throws(
    () => runtime.devices.select({ providerId: 'example', generation: 'g1', localId: 'same' }),
    (error: unknown) => error instanceof HostError && error.code === 'conflict',
  );
  await assert.rejects(
    runtime.devices.invoke(action(), signal()),
    (error: unknown) => error instanceof HostError && error.code === 'conflict',
  );
  response.resolve(failure('dependency_failed', 502));
  await rejected;
  assert.deepEqual(runtime.devices.snapshot().directories, []);
  late = false;
  assert.equal(
    (await runtime.devices.refreshProvider('example', 'g1', signal())).logId,
    'new-observation',
  );
  assert.equal(runtime.devices.snapshot().directories.length, 1);
  await runtime.dispose();
});

test('替代刷新成功不会被旧请求失败清除，跨提供者同时刷新互不误伤', async () => {
  const old = deferred<Response>();
  const oldStarted = deferred<void>();
  const second = deferred<Response>();
  const secondStarted = deferred<void>();
  let firstRefreshes = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      if (path === '/api/v2/device-providers/first/refresh') {
        if (++firstRefreshes === 1) {
          oldStarted.resolve();
          return old.promise;
        }
        return success({ ...directory('first'), observed_at: 2 });
      }
      if (path === '/api/v2/device-providers/second/refresh') {
        secondStarted.resolve();
        return second.promise;
      }
      return success(
        path.endsWith('device-providers')
          ? [provider('first'), provider('second')]
          : [directory('first'), directory('second')],
      );
    },
  });
  await runtime.devices.refreshDirectories(signal());
  const first = runtime.devices.refreshProvider('first', 'g1', signal());
  const rejected = assert.rejects(
    first,
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  await oldStarted.promise;
  const parallel = runtime.devices.refreshProvider('second', 'g1', signal());
  await secondStarted.promise;
  assert.deepEqual(runtime.devices.snapshot().directories, []);
  await runtime.devices.refreshProvider('first', 'g1', signal());
  await rejected;
  second.resolve(success(directory('second')));
  await parallel;
  old.resolve(failure('dependency_failed', 502));
  assert.equal(
    runtime.devices.snapshot().directories.find((item) => item.provider.id === 'first')?.observedAt,
    2,
  );
  assert.equal(
    runtime.devices.snapshot().directories.find((item) => item.provider.id === 'second')?.devices
      .length,
    1,
  );
  await runtime.dispose();
});

test('提供者卸载/代变撤销旧引用和在途发现，重载不复活旧目录', async () => {
  let current = 'g1';
  const response = deferred<Response>();
  const started = deferred<AbortSignal | null | undefined>();
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/refresh')) {
        started.resolve(init?.signal);
        return response.promise;
      }
      return success(
        path.endsWith('device-providers')
          ? current
            ? [provider('example', current)]
            : []
          : [directory('example', current)],
      );
    },
  });
  await runtime.devices.refreshDirectories(signal());
  const waiting = runtime.devices.refreshProvider('example', 'g1', signal());
  const rejected = assert.rejects(
    waiting,
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  const combined = await started.promise;
  current = 'g2';
  await runtime.devices.refreshProviders(signal());
  assert.equal(combined?.aborted, true);
  await rejected;
  response.resolve(success(directory()));
  assert.deepEqual(runtime.devices.snapshot().directories, []);
  await assert.rejects(
    runtime.devices.invoke(action(), signal()),
    (error: unknown) =>
      error instanceof HostError &&
      error.code === 'conflict' &&
      error.status === 409 &&
      error.logId === null,
  );
  assert.throws(
    () => runtime.devices.select({ providerId: 'example', generation: 'g1', localId: 'same' }),
    /插件已更新.*设备信息已过期/,
  );
  await runtime.devices.refreshDirectories(signal());
  assert.equal(runtime.devices.snapshot().directories[0]?.provider.generation, 'g2');
  current = '';
  await runtime.devices.refreshProviders(signal());
  assert.deepEqual(runtime.devices.snapshot().directories, []);
  await assert.rejects(
    runtime.devices.invoke(action({ generation: 'g2' }), signal()),
    (error: unknown) => error instanceof HostError && error.code === 'not_found',
  );
  await runtime.dispose();
});

test('聚合目录晚到不能覆盖较新的单提供者观测或重载代次', async () => {
  const response = deferred<Response>();
  const started = deferred<void>();
  let current = 'g1';
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      if (requestUrl(input).pathname.endsWith('device-providers'))
        return success([provider('example', current)]);
      started.resolve();
      return response.promise;
    },
  });
  const waiting = runtime.devices.refreshDirectories(signal());
  const rejected = assert.rejects(
    waiting,
    (error: unknown) =>
      error instanceof HostError &&
      error.kind === 'cancelled' &&
      error.logId === 'late-directory-log',
  );
  await started.promise;
  current = 'g2';
  await runtime.devices.refreshProviders(signal());
  response.resolve(success([directory()], 'late-directory-log'));
  await rejected;
  assert.deepEqual(runtime.devices.snapshot().directories, []);
  assert.equal(runtime.devices.snapshot().providers[0]?.generation, 'g2');
  await runtime.dispose();
});

test('缺能力/版本、缺观测、离线/未授权/未知和不可用能力明确拒绝，不发送动作', async () => {
  let observed: DeviceDirectoryDto = directory();
  let requests = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      if (requestUrl(input).pathname.endsWith('device-actions')) {
        ++requests;
        return success(job());
      }
      return success(
        requestUrl(input).pathname.endsWith('device-providers') ? [provider()] : [observed],
      );
    },
  });
  await runtime.devices.refreshProviders(signal());
  await assert.rejects(
    runtime.devices.invoke(action(), signal()),
    (error: unknown) => error instanceof HostError && error.code === 'conflict',
  );
  await runtime.devices.refreshDirectories(signal());
  for (const variant of [
    action({ capability: 'missing' }),
    action({ version: 2 }),
    action({ deviceId: 'missing' }),
  ]) {
    await assert.rejects(
      runtime.devices.invoke(variant, signal()),
      (error: unknown) =>
        error instanceof HostError && error.code === 'not_found' && error.status === 404,
    );
  }
  for (const variant of [action({ deviceId: null }), action({ capability: 'manage' })]) {
    await assert.rejects(
      runtime.devices.invoke(variant, signal()),
      (error: unknown) =>
        error instanceof HostError && error.code === 'invalid_input' && error.status === 400,
    );
  }
  const states: DeviceDirectoryDto['devices'][number]['state'][] = [
    'offline',
    'unauthorized',
    'unknown',
  ];
  for (const state of states) {
    observed = directory();
    const device = observed.devices[0];
    assert.ok(device);
    device.state = state;
    await runtime.devices.refreshDirectories(signal());
    await assert.rejects(
      runtime.devices.invoke(action(), signal()),
      (error: unknown) =>
        error instanceof HostError && error.code === 'conflict' && error.status === 409,
    );
  }
  for (const missing of [false, true]) {
    observed = directory();
    const device = observed.devices[0];
    assert.ok(device);
    device.capabilities = missing
      ? []
      : [{ id: 'read', version: 1, available: false, reason: '设备尚未准备好' }];
    await runtime.devices.refreshDirectories(signal());
    await assert.rejects(
      runtime.devices.invoke(action(), signal()),
      (error: unknown) => error instanceof HostError && error.code === 'conflict',
    );
  }
  assert.equal(requests, 0);
  await runtime.dispose();
});

test('服务器设备错误保留冻结状态/错误码和真实日志，取消不重放请求', async () => {
  const errors: { code: string; status: number }[] = [
    { code: 'not_found', status: 404 },
    { code: 'conflict', status: 409 },
    { code: 'dependency_failed', status: 502 },
    { code: 'invalid_input', status: 400 },
    { code: 'cancelled', status: 409 },
  ];
  for (const { code, status } of errors) {
    const response = failure(code, status);
    const runtime = createFrontendRuntime({
      baseUrl: 'http://localhost:7031',
      panelTarget: () => null,
      transport: async (input) => {
        if (requestUrl(input).pathname.endsWith('/refresh')) return response;
        return success([provider()]);
      },
    });
    await runtime.devices.refreshProviders(signal());
    await assert.rejects(
      deviceHost(runtime.host.devices).refreshProvider('example', 'g1', signal()),
      (error: unknown) => {
        assert.ok(error instanceof HostError);
        assert.equal(error.kind, 'http');
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.equal(error.logId, 'log-error');
        return true;
      },
    );
    await runtime.dispose();
  }
  const response = deferred<Response>();
  const started = deferred<void>();
  let posts = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/refresh')) {
        ++posts;
        started.resolve();
        return response.promise;
      }
      return success(path.endsWith('device-providers') ? [provider()] : [directory()]);
    },
  });
  await runtime.devices.refreshDirectories(signal());
  const cancellation = new AbortController();
  const waiting = runtime.devices.refreshProvider('example', 'g1', cancellation.signal);
  const rejected = assert.rejects(
    waiting,
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  await started.promise;
  cancellation.abort();
  await rejected;
  response.resolve(success(directory()));
  assert.equal(posts, 1);
  assert.deepEqual(runtime.devices.snapshot().directories, []);
  await runtime.dispose();
});

test('生成设备响应拒绝身份错配、重复设备/提供者、未知状态与未声明能力，保留响应日志', async () => {
  const source = directory();
  const original = source.devices[0];
  assert.ok(original);
  const malformed: unknown[] = [
    { ...source, devices: [original, original] },
    {
      ...source,
      devices: [{ ...original, reference: { ...original.reference, provider_id: 'other' } }],
    },
    {
      ...source,
      devices: [{ ...original, reference: { ...original.reference, generation: 'old' } }],
    },
    { ...source, devices: [{ ...original, state: 'invented' }] },
    {
      ...source,
      devices: [{ ...original, capabilities: [{ id: 'undeclared', version: 1, available: true }] }],
    },
    {
      ...source,
      devices: [{ ...original, capabilities: [{ id: 'read', version: 1, available: 'true' }] }],
    },
    { ...source, observed_at: -1 },
  ];
  for (const body of malformed) {
    const client = createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async () => success(body, 'malformed-device-log'),
    });
    await assert.rejects(
      client.call(refreshDeviceProviderEndpoint, { id: 'example', generation: 'g1' }, signal()),
      (error: unknown) =>
        error instanceof ApiError &&
        error.kind === 'protocol' &&
        error.logId === 'malformed-device-log',
    );
  }
  for (const body of [
    [provider(), provider()],
    [{ ...provider(), definition: { ...provider().definition, api_version: 4 } }],
  ]) {
    const client = createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async () => success(body),
    });
    await assert.rejects(client.call(deviceProvidersEndpoint, undefined, signal()), /生成契约/);
  }
  const client = createApiClient({
    baseUrl: 'http://localhost:7031',
    transport: async () => success([source, source]),
  });
  await assert.rejects(client.call(deviceDirectoriesEndpoint, undefined, signal()), /生成契约/);
  assert.equal(
    refreshDeviceProviderEndpoint.request({ id: 'a/b', generation: 'g1' }).path,
    '/api/v2/device-providers/a%2Fb/refresh',
  );
});

test('宿主设备订阅随 dispose 释放且回调失败互不污染，全部入口关闭后拒绝', async () => {
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) =>
      success(
        requestUrl(input).pathname.endsWith('device-providers') ? [provider()] : [directory()],
      ),
  });
  const host = deviceHost(runtime.host.devices);
  let changes = 0;
  host.subscribe(() => {
    throw new Error('观察者失败');
  });
  const unsubscribe = host.subscribe(() => {
    ++changes;
  });
  await host.refreshDirectories(signal());
  assert.ok(changes > 0);
  await unsubscribe();
  const before = changes;
  await host.refreshProviders(signal());
  assert.equal(changes, before);
  await runtime.dispose();
  assert.throws(
    () => host.snapshot(),
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  assert.throws(
    () => host.select(null),
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  assert.throws(
    () => host.subscribe(() => {}),
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  for (const waiting of [
    host.refreshProviders(signal()),
    host.refreshDirectories(signal()),
    host.refreshProvider('example', 'g1', signal()),
    host.invoke(action(), signal()),
  ]) {
    await assert.rejects(
      waiting,
      (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
    );
  }
});

test('本实例服务器/在线包管理后同步设备目录，停用即撤销选择与旧引用', async () => {
  let running = true;
  let generation = 'g1';
  const seen: string[] = [];
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      seen.push(path);
      if (path.endsWith('/load')) {
        running = true;
        generation = 'g2';
        return success(plugin({ generation }));
      }
      if (path.endsWith('/unload')) {
        running = false;
        return success(plugin({ state: 'unloaded', generation }));
      }
      if (path === '/api/v2/plugins') return success(running ? [plugin({ generation })] : []);
      if (path === '/api/v2/device-providers')
        return success(running ? [provider('example', generation)] : []);
      if (path === '/api/v2/devices')
        return success(running ? [directory('example', generation)] : []);
      return success([]);
    },
  });
  await runtime.devices.refreshDirectories(signal());
  runtime.devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
  await runtime.pluginPackages.disable('server', 'example', signal());
  assert.deepEqual(runtime.devices.snapshot().providers, []);
  assert.deepEqual(runtime.devices.snapshot().directories, []);
  assert.equal(runtime.devices.snapshot().selection, null);
  await assert.rejects(
    runtime.devices.invoke(action(), signal()),
    (error: unknown) => error instanceof HostError && error.code === 'not_found',
  );
  await runtime.serverPlugins.load('example', signal());
  assert.equal(runtime.devices.snapshot().providers[0]?.generation, 'g2');
  assert.equal(runtime.devices.snapshot().directories[0]?.provider.generation, 'g2');
  assert.equal(runtime.devices.snapshot().selection, null);
  await assert.rejects(
    runtime.devices.invoke(action(), signal()),
    (error: unknown) => error instanceof HostError && error.code === 'conflict',
  );
  assert.ok(seen.includes('/api/v2/operations'));
  assert.ok(seen.includes('/api/v2/devices'));
  await runtime.dispose();
});

test('本地卸载后的设备重查失败仍清受影响快照与选择，取消/错误不假定后端回滚', async () => {
  const started = deferred<void>();
  const response = deferred<Response>();
  let failQueries = false;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/unload')) {
        started.resolve();
        return response.promise;
      }
      if (path === '/api/v2/device-providers')
        return failQueries ? failure('dependency_failed', 502) : success([provider()]);
      if (path === '/api/v2/devices') return success([directory()]);
      return success([]);
    },
  });
  await runtime.devices.refreshDirectories(signal());
  runtime.devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
  const cancellation = new AbortController();
  const waiting = runtime.serverPlugins.unload('example', cancellation.signal);
  const rejected = assert.rejects(
    waiting,
    (error: unknown) => error instanceof ApiError && error.kind === 'cancelled',
  );
  await started.promise;
  failQueries = true;
  cancellation.abort();
  await rejected;
  assert.deepEqual(runtime.devices.snapshot().providers, []);
  assert.deepEqual(runtime.devices.snapshot().directories, []);
  assert.equal(runtime.devices.snapshot().selection, null);
  response.resolve(failure('cleanup_failed'));
  await runtime.dispose();
});
