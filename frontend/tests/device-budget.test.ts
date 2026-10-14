import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import {
  ApiError,
  createApiClient,
  deviceDirectoriesEndpoint,
  deviceProvidersEndpoint,
} from '../src/services/api/index.ts';
import { isDeviceDirectory, isDeviceProvider } from '../src/services/api/device-validation.ts';
import { directory, provider } from './device-fixtures.ts';
import { job, requestUrl, signal, success } from './fixtures.ts';

// 从旧生成夹具扩展未知响应，验证缺省、空值与非法字段，不复制生产 DTO。
function declaration(apiVersion: number, timeout: unknown = undefined) {
  const source = provider();
  return {
    ...source,
    definition: {
      ...source.definition,
      api_version: apiVersion,
      capabilities: source.definition.capabilities.map((item) => ({
        ...item,
        ...(timeout === undefined ? {} : { execution_timeout_ms: timeout }),
      })),
    },
  };
}
function observed(apiVersion: number, timeout: unknown = undefined) {
  return { ...directory(), provider: declaration(apiVersion, timeout) };
}

test('设备 API 1/2 缺省或 null 预算保持未声明，SDK 不补默认值且旧目录仍可用', async () => {
  for (const apiVersion of [1, 2])
    for (const timeout of [undefined, null]) {
      const runtime = createFrontendRuntime({
        baseUrl: 'http://localhost:7031',
        panelTarget: () => null,
        transport: async (input) =>
          success(
            requestUrl(input).pathname.endsWith('device-providers')
              ? [declaration(apiVersion, timeout)]
              : [observed(apiVersion, timeout)],
            'default-budget-log',
          ),
      });
      try {
        const devices = runtime.host.devices;
        assert.ok(devices);
        const providers = await devices.refreshProviders(signal());
        const entry = providers.data[0];
        assert.ok(entry);
        assert.equal(entry.definition.apiVersion, apiVersion);
        for (const capability of entry.definition.capabilities) {
          assert.equal(capability.executionTimeoutMs, undefined);
          assert.equal(Object.hasOwn(capability, 'executionTimeoutMs'), false);
        }
        const directories = await devices.refreshDirectories(signal());
        assert.equal(directories.logId, 'default-budget-log');
        assert.equal(
          directories.data[0]?.provider.definition.capabilities[0]?.executionTimeoutMs,
          undefined,
        );
        devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
        assert.equal(devices.snapshot().selected?.reference.localId, 'same');
      } finally {
        await runtime.dispose();
      }
    }
});

test('API 2 的预算上下界透明进入公开目录，invoke 只发送原动作与业务输入', async () => {
  for (const timeout of [1, 120000]) {
    let actions = 0;
    const runtime = createFrontendRuntime({
      baseUrl: 'http://localhost:7031',
      panelTarget: () => null,
      transport: async (input, init) => {
        const path = requestUrl(input).pathname;
        if (path === '/api/v2/device-providers') return success([declaration(2, timeout)]);
        if (path === '/api/v2/devices') return success([observed(2, timeout)]);
        if (path.endsWith('/refresh')) {
          assert.equal(init?.body, JSON.stringify({ generation: 'g1' }));
          return success(observed(2, timeout));
        }
        assert.equal(path, '/api/v2/device-actions');
        ++actions;
        assert.equal(
          init?.body,
          JSON.stringify({
            provider_id: 'example',
            generation: 'g1',
            device_id: 'same',
            capability: 'read',
            version: 1,
            input: { artifact_id: 'existing-artifact' },
          }),
        );
        return success(job('budget-job'), 'budget-action-log', 202);
      },
    });
    try {
      const devices = runtime.host.devices;
      assert.ok(devices);
      const providers = await devices.refreshProviders(signal());
      assert.equal(providers.data[0]?.definition.capabilities[0]?.executionTimeoutMs, timeout);
      const directories = await devices.refreshDirectories(signal());
      assert.equal(
        directories.data[0]?.provider.definition.capabilities[0]?.executionTimeoutMs,
        timeout,
      );
      const refreshed = await devices.refreshProvider('example', 'g1', signal());
      const capability = refreshed.data.provider.definition.capabilities[0];
      assert.ok(capability);
      assert.equal(capability.executionTimeoutMs, timeout);
      assert.equal(Object.isFrozen(capability), true);
      const invoked = await devices.invoke(
        {
          providerId: 'example',
          generation: 'g1',
          deviceId: 'same',
          capability: 'read',
          version: 1,
          input: { artifact_id: 'existing-artifact' },
        },
        signal(),
      );
      assert.equal(invoked.data.id, 'budget-job');
      assert.equal(invoked.logId, 'budget-action-log');
      assert.equal(actions, 1);
    } finally {
      await runtime.dispose();
    }
  }
});

test('同一提供者的预算按各自能力映射，未声明能力不继承其他能力预算', async () => {
  const source = declaration(2);
  const declared = {
    ...source,
    definition: {
      ...source.definition,
      capabilities: source.definition.capabilities.map((item, index) =>
        index === 0 ? { ...item, execution_timeout_ms: 120000 } : item,
      ),
    },
  };
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) =>
      success(
        requestUrl(input).pathname.endsWith('device-providers')
          ? [declared]
          : [{ ...directory(), provider: declared }],
      ),
  });
  try {
    const devices = runtime.host.devices;
    assert.ok(devices);
    await devices.refreshDirectories(signal());
    const snapshot = devices.snapshot();
    for (const entry of [snapshot.providers[0], snapshot.directories[0]?.provider]) {
      assert.ok(entry);
      assert.equal(entry.definition.capabilities[0]?.executionTimeoutMs, 120000);
      const other = entry.definition.capabilities[1];
      assert.ok(other);
      assert.equal(Object.hasOwn(other, 'executionTimeoutMs'), false);
    }
  } finally {
    await runtime.dispose();
  }
});

test('声明校验拒绝未知版本、API 1 非空预算和 API 2 非整数/非有限/越界值', () => {
  const malformed = [
    declaration(0),
    declaration(4),
    declaration(1, 1),
    declaration(1, 30000),
    ...[0, -1, 120001, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '30000', true, [], {}].map(
      (timeout) => declaration(2, timeout),
    ),
  ];
  for (const source of malformed) {
    assert.equal(isDeviceProvider(source), false);
    assert.equal(isDeviceDirectory({ ...directory(), provider: source }), false);
  }
});

test('非法声明响应不能进入提供者或观测目录，协议错误保留真实日志 ID', async () => {
  for (const source of [
    declaration(1, 120000),
    declaration(2, 0),
    declaration(2, 120001),
    declaration(2, '30000'),
  ]) {
    const client = createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async (input) =>
        success(
          requestUrl(input).pathname.endsWith('device-providers')
            ? [source]
            : [{ ...directory(), provider: source }],
          'invalid-budget-log',
        ),
    });
    const rejected = (error: unknown) =>
      error instanceof ApiError &&
      error.kind === 'protocol' &&
      error.logId === 'invalid-budget-log';
    await assert.rejects(client.call(deviceProvidersEndpoint, undefined, signal()), rejected);
    await assert.rejects(client.call(deviceDirectoriesEndpoint, undefined, signal()), rejected);
  }
});
