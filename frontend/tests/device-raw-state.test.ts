import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DeviceSnapshot } from '../src/plugin-sdk/index.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import {
  ApiError,
  createApiClient,
  deviceDirectoriesEndpoint,
  refreshDeviceProviderEndpoint,
} from '../src/services/api/index.ts';
import type { DeviceDirectoryDto } from '../src/services/api/index.ts';
import { isDeviceDirectory, isDeviceProvider } from '../src/services/api/device-validation.ts';
import { directory, provider } from './device-fixtures.ts';
import { deferred, failure, job, requestUrl, signal, success } from './fixtures.ts';

// 扩展已有生成夹具来测试未知响应，不复制 HTTP DTO 或绕过类型检查。
function declaration(apiVersion = 3, timeout: unknown = undefined, generation = 'g1') {
  const source = provider('example', generation);
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
function observed(
  rawState: unknown = undefined,
  apiVersion = 3,
  state: DeviceDirectoryDto['devices'][number]['state'] = 'unknown',
  generation = 'g1',
) {
  const source = directory('example', generation);
  return {
    ...source,
    provider: declaration(apiVersion, undefined, generation),
    devices: source.devices.map((item) => ({
      ...item,
      state,
      ...(rawState === undefined ? {} : { raw_state: rawState }),
    })),
  };
}

test('API 1/2 原始状态缺失或 null 兼容，非 null 拒绝，API 3 可省略或保留未知原文', () => {
  for (const apiVersion of [1, 2, 3]) {
    assert.equal(isDeviceProvider(declaration(apiVersion)), true);
    for (const raw of [undefined, null])
      assert.equal(isDeviceDirectory(observed(raw, apiVersion)), true);
  }
  for (const apiVersion of [1, 2])
    for (const raw of ['', 'recovery', '未知状态', 1, false, {}]) {
      assert.equal(isDeviceDirectory(observed(raw, apiVersion)), false);
    }
  for (const raw of ['recovery', 'sideload', 'bootloader', ' MixedCase 未知 ']) {
    assert.equal(isDeviceDirectory(observed(raw)), true);
  }
  assert.equal(isDeviceProvider(declaration(4)), false);
  const source = observed('bootloader');
  const device = source.devices[0];
  assert.ok(device);
  assert.equal(
    isDeviceDirectory({ ...source, devices: [{ ...device, state: 'bootloader' }] }),
    false,
  );
});

test('原始状态限制按 UTF-8 字节及 Rust Unicode 空白/控制字符判断，保留合法格式字符', () => {
  const valid = [
    'x'.repeat(100),
    '中'.repeat(33) + 'x',
    '😀'.repeat(25),
    '\uFEFF',
    '\u200B',
    ' recovery ',
  ];
  for (const raw of valid)
    assert.equal(isDeviceDirectory(observed(raw)), true, `合法原文：${JSON.stringify(raw)}`);
  const invalid = [
    '',
    ' \u3000\u2028 ',
    'x'.repeat(101),
    '中'.repeat(33) + 'xx',
    '😀'.repeat(26),
    '\uD800',
    '\uDC00',
    1,
    true,
    [],
    {},
  ];
  // char::is_control 对应 Cc，包含 C0、DEL 与 C1；格式字符 Cf 不能被误当控制字符。
  for (let code = 0; code <= 0x9f; ++code) {
    if (code < 0x20 || code >= 0x7f) invalid.push(`x${String.fromCodePoint(code)}`);
  }
  for (const raw of invalid)
    assert.equal(isDeviceDirectory(observed(raw)), false, `非法原文：${JSON.stringify(raw)}`);
});

test('API 3 继承 API 2 能力预算而 API 1 非空预算仍拒绝', () => {
  for (const apiVersion of [2, 3])
    for (const timeout of [undefined, null, 1, 120000]) {
      assert.equal(isDeviceProvider(declaration(apiVersion, timeout)), true);
    }
  for (const timeout of [0, -1, 120001, 1.5, NaN, Infinity, '30000', true]) {
    assert.equal(isDeviceProvider(declaration(3, timeout)), false);
  }
  assert.equal(isDeviceProvider(declaration(1, 30000)), false);
});

test('生成响应经公开 SDK 原样映射 rawState，None 真正省略且预算不补默认值', async () => {
  const cases = [
    { version: 1, raw: undefined },
    { version: 1, raw: null },
    { version: 2, raw: undefined },
    { version: 2, raw: null },
    { version: 3, raw: undefined },
    { version: 3, raw: null },
    { version: 3, raw: ' MixedCase 未知 ' },
    { version: 3, raw: '\uFEFF' },
  ];
  for (const entry of cases) {
    const snapshots: DeviceSnapshot[] = [];
    const declared = declaration(entry.version, entry.version === 3 ? 120000 : undefined);
    const observation = { ...observed(entry.raw, entry.version), provider: declared };
    const runtime = createFrontendRuntime({
      baseUrl: 'http://localhost:7031',
      panelTarget: () => null,
      transport: async (input, init) => {
        const path = requestUrl(input).pathname;
        if (path === '/api/v2/device-providers') return success([declared], 'raw-provider-log');
        if (path.endsWith('/refresh')) {
          assert.equal(init?.body, JSON.stringify({ generation: 'g1' }));
          return success(observation, 'raw-refresh-log');
        }
        assert.equal(path, '/api/v2/devices');
        return success([observation], 'raw-directory-log');
      },
    });
    try {
      const devices = runtime.host.devices;
      assert.ok(devices);
      assert.equal(runtime.host.apiVersion, 2);
      const release = devices.subscribe((snapshot) => snapshots.push(snapshot));
      await devices.refreshDirectories(signal());
      const refreshed = await devices.refreshProvider('example', 'g1', signal());
      assert.equal(refreshed.logId, 'raw-refresh-log');
      devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
      for (const device of [
        refreshed.data.devices[0],
        devices.snapshot().selected,
        snapshots.at(-1)?.selected,
      ]) {
        assert.ok(device);
        assert.equal(device.rawState, entry.raw ?? undefined);
        assert.equal(Object.hasOwn(device, 'rawState'), entry.raw != null);
        assert.equal(Object.isFrozen(device), true);
      }
      const capability = devices.snapshot().providers[0]?.definition.capabilities[0];
      assert.ok(capability);
      assert.equal(capability.executionTimeoutMs, entry.version === 3 ? 120000 : undefined);
      assert.equal(Object.hasOwn(capability, 'executionTimeoutMs'), entry.version === 3);
      await release();
    } finally {
      await runtime.dispose();
    }
  }
});

test('一项非法原始状态拒绝整份目录，GET 与 refresh 协议错误保留响应日志', async () => {
  const source = observed('recovery');
  const device = source.devices[0];
  assert.ok(device);
  const invalid = {
    ...source,
    devices: [
      ...source.devices,
      {
        ...device,
        reference: { ...device.reference, local_id: 'other' },
        raw_state: 'bad\u0085state',
      },
    ],
  };
  const client = createApiClient({
    baseUrl: 'http://localhost:7031',
    transport: async (input) =>
      success(
        requestUrl(input).pathname.endsWith('/refresh') ? invalid : [invalid],
        'invalid-raw-log',
      ),
  });
  const rejected = (error: unknown) =>
    error instanceof ApiError && error.kind === 'protocol' && error.logId === 'invalid-raw-log';
  await assert.rejects(client.call(deviceDirectoriesEndpoint, undefined, signal()), rejected);
  await assert.rejects(
    client.call(refreshDeviceProviderEndpoint, { id: 'example', generation: 'g1' }, signal()),
    rejected,
  );
});

test('同代下一轮 None 整份替换旧 raw，嵌套插件作用域及订阅不补上一轮值', async () => {
  let raw: unknown = 'recovery';
  const snapshots: DeviceSnapshot[] = [];
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) =>
      success(
        requestUrl(input).pathname === '/api/v2/device-providers'
          ? [declaration()]
          : [observed(raw)],
      ),
  });
  const instance = createPluginScope(runtime.host);
  const mounted = createPluginScope(instance.context);
  try {
    const devices = mounted.context.devices;
    assert.ok(devices);
    devices.subscribe((snapshot) => snapshots.push(snapshot));
    await devices.refreshDirectories(signal());
    devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
    assert.equal(devices.snapshot().selected?.rawState, 'recovery');
    for (raw of [undefined, null]) {
      await devices.refreshDirectories(signal());
      const selected: DeviceSnapshot['selected'] = devices.snapshot().selected;
      assert.ok(selected);
      assert.equal(Object.hasOwn(selected, 'rawState'), false);
      assert.equal(Object.hasOwn(snapshots.at(-1)?.selected ?? {}, 'rawState'), false);
    }
    await mounted.dispose();
    const count = snapshots.length;
    raw = 'bootloader';
    await runtime.devices.refreshDirectories(signal());
    assert.equal(snapshots.length, count);
    assert.throws(
      () => devices.snapshot(),
      (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
    );
  } finally {
    await mounted.dispose();
    await instance.dispose();
    await runtime.dispose();
  }
});

test('本地先清旧观测与排队 GET 保留旧观测分别消费，晚到 A 回执不得覆盖修订后的 B', async () => {
  for (const lateFailure of [false, true]) {
    const response = deferred<Response>();
    const started = deferred<void>();
    const seen: string[] = [];
    let current = { ...observed('old-state'), discovery_job_id: 'old-job' };
    const runtime = createFrontendRuntime({
      baseUrl: 'http://localhost:7031',
      panelTarget: () => null,
      transport: async (input) => {
        const path = requestUrl(input).pathname;
        if (path === '/api/v2/device-providers') return success([declaration()]);
        if (path.endsWith('/refresh')) {
          started.resolve();
          return response.promise;
        }
        return success([current], 'get-observation-log');
      },
    });
    try {
      const devices = runtime.host.devices;
      assert.ok(devices);
      devices.subscribe((snapshot) => {
        const raw = snapshot.directories[0]?.devices[0]?.rawState;
        if (raw) seen.push(raw);
      });
      await devices.refreshDirectories(signal());
      devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
      const waiting = devices.refreshProvider('example', 'g1', signal());
      const rejected = assert.rejects(
        waiting,
        (error: unknown) =>
          error instanceof HostError &&
          (lateFailure
            ? error.code === 'dependency_failed' && error.logId === 'log-error'
            : error.code === 'stale_device_result' && error.logId === 'receipt-a-log'),
      );
      await started.promise;
      assert.deepEqual(devices.snapshot().directories, []);
      assert.equal(devices.snapshot().selection, null);
      // 受控响应表示排队阶段 GET 仍有旧目录；这不证明后端锁或实际清空时点。
      const queued = await devices.refreshDirectories(signal());
      assert.equal(queued.data[0]?.discoveryJobId, 'old-job');
      current = { ...observed('state-b'), discovery_job_id: 'job-b' };
      await devices.refreshDirectories(signal());
      response.resolve(
        lateFailure
          ? failure('dependency_failed', 502)
          : success({ ...observed('state-a'), discovery_job_id: 'job-a' }, 'receipt-a-log'),
      );
      await rejected;
      assert.equal(devices.snapshot().directories[0]?.discoveryJobId, 'job-b');
      assert.equal(devices.snapshot().directories[0]?.devices[0]?.rawState, 'state-b');
      assert.equal(seen.includes('state-a'), false);
    } finally {
      await runtime.dispose();
    }
  }
});

test('插件实例退出取消子作用域发现与订阅，旧代原文晚到不能进入新代目录', async () => {
  const response = deferred<Response>();
  const started = deferred<AbortSignal | null | undefined>();
  let generation = 'g1';
  let notifications = 0;
  let writes = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      if (path === '/api/v2/device-providers')
        return success([declaration(3, undefined, generation)]);
      if (path.endsWith('/refresh')) {
        started.resolve(init?.signal);
        return response.promise;
      }
      return success([observed('current-raw', 3, 'unknown', generation)]);
    },
  });
  const instance = createPluginScope(runtime.host);
  const mounted = createPluginScope(instance.context);
  try {
    const devices = mounted.context.devices;
    assert.ok(devices);
    devices.subscribe(() => {
      ++notifications;
    });
    await devices.refreshDirectories(signal());
    const waiting = devices.refreshProvider('example', 'g1', signal()).then((value) => {
      ++writes;
      return value;
    });
    const rejected = assert.rejects(
      waiting,
      (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
    );
    const combined = await started.promise;
    await instance.dispose();
    assert.equal(combined?.aborted, true);
    await rejected;
    const count = notifications;
    generation = 'g2';
    await runtime.devices.refreshDirectories(signal());
    response.resolve(success(observed('late-g1-raw'), 'late-raw-log'));
    assert.equal(writes, 0);
    assert.equal(notifications, count);
    assert.equal(runtime.devices.snapshot().directories[0]?.provider.generation, 'g2');
    assert.equal(runtime.devices.snapshot().directories[0]?.devices[0]?.rawState, 'current-raw');
    for (const access of [
      () => devices.snapshot(),
      () => devices.select(null),
      () => devices.subscribe(() => {}),
    ]) {
      assert.throws(
        access,
        (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
      );
    }
  } finally {
    await mounted.dispose();
    await instance.dispose();
    await runtime.dispose();
  }
});

test('特殊原文不放行非 online 或不可用设备，也不自行否决已满足规范状态的动作', async () => {
  let current = observed('recovery');
  let actions = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      if (path === '/api/v2/device-providers') return success([declaration()]);
      if (path === '/api/v2/device-actions') {
        ++actions;
        return success(job('raw-independent-job'));
      }
      return success([current]);
    },
  });
  try {
    const devices = runtime.host.devices;
    assert.ok(devices);
    const action = {
      providerId: 'example',
      generation: 'g1',
      deviceId: 'same',
      capability: 'read',
      version: 1,
      input: {},
    };
    const rejected = (error: unknown) =>
      error instanceof HostError && error.code === 'conflict' && error.logId === null;
    const states: DeviceDirectoryDto['devices'][number]['state'][] = [
      'unknown',
      'offline',
      'unauthorized',
    ];
    for (const state of states) {
      current = observed('bootloader', 3, state);
      await devices.refreshDirectories(signal());
      await assert.rejects(devices.invoke(action, signal()), rejected);
    }
    const online = observed('sideload', 3, 'online');
    current = {
      ...online,
      devices: online.devices.map((item) => ({
        ...item,
        capabilities: item.capabilities.map((capability) => ({ ...capability, available: false })),
      })),
    };
    await devices.refreshDirectories(signal());
    await assert.rejects(devices.invoke(action, signal()), rejected);
    assert.equal(actions, 0);
    current = online;
    await devices.refreshDirectories(signal());
    assert.equal((await devices.invoke(action, signal())).data.id, 'raw-independent-job');
    assert.equal(actions, 1);
  } finally {
    await runtime.dispose();
  }
});
