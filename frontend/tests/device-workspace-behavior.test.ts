import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductServices } from '../src/app/product/services.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { DeviceCapability, DeviceSnapshot, ProvidedDevice } from '../src/plugin-sdk/index.ts';
import {
  capabilityReason,
  discoverProviders,
  executeCapability,
  parseCapabilityInput,
} from '../src/pages/devices/workspace.ts';
import { directory, provider } from './device-fixtures.ts';
import { deferred, failure, job, requestUrl, signal, success } from './fixtures.ts';

const read: DeviceCapability = {
  id: 'read',
  version: 1,
  operation: 'example.read',
  scope: 'device',
  access: 'read',
};
const operation = { id: 'example.read', title: '读取设备信息', input_schema: { type: 'object' } };
function snapshot(state: ProvidedDevice['state'] = 'online'): DeviceSnapshot {
  const reference = { providerId: 'example', generation: 'g1', localId: 'same' };
  const selected: ProvidedDevice = {
    reference,
    model: null,
    state,
    capabilities: [{ id: 'read', version: 1, available: true, reason: null }],
  };
  return {
    providers: [
      {
        id: 'example',
        generation: 'g1',
        version: '1',
        definition: {
          apiVersion: 1,
          platform: '任意平台',
          discoverOperation: 'example.discover',
          capabilities: [read],
        },
      },
    ],
    directories: [],
    selection: reference,
    selected,
  };
}

test('设备能力按完整引用、精确版本、在线和实际目录准入，平台不参与判断', () => {
  const state = snapshot();
  assert.ok(state.selection);
  assert.ok(state.selected);
  assert.equal(capabilityReason(state, [operation], state.selection, read), null);
  assert.match(
    capabilityReason(state, [operation], state.selection, { ...read, version: 2 }) ?? '',
    /版本/,
  );
  assert.match(
    capabilityReason(snapshot('unauthorized'), [operation], state.selection, read) ?? '',
    /授权/,
  );
  assert.match(
    capabilityReason(snapshot('offline'), [operation], state.selection, read) ?? '',
    /离线/,
  );
  assert.match(capabilityReason(state, [], state.selection, read) ?? '', /服务器目录/);
  assert.match(
    capabilityReason(state, [operation], { ...state.selection, providerId: 'other' }, read) ?? '',
    /提供者/,
  );
  const denied = {
    ...state,
    selected: {
      ...state.selected,
      capabilities: [{ id: 'read', version: 1, available: false, reason: '设备权限不足' }],
    },
  };
  assert.equal(capabilityReason(denied, [operation], state.selection, read), '设备权限不足');
});

test('高级能力输入仅接纳有限 JSON 对象，不把数组、null或错误文本提交给服务器', () => {
  assert.deepEqual(parseCapabilityInput('{"nested":{"value":3}}'), { nested: { value: 3 } });
  for (const text of ['null', '[]', '"text"', '{', '{"value":1e400}'])
    assert.throws(() => parseCapabilityInput(text), ApiError);
});

test('全量设备发现串行调用真实刷新端点，失败保留日志并继续其他提供者', async () => {
  const paths: string[] = [];
  let active = 0;
  let maximum = 0;
  const services = createProductServices({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      paths.push(path);
      if (path.endsWith('/device-providers'))
        return success([provider('first'), provider('second'), provider('third')], 'providers-log');
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const id = path.split('/')[4];
      return id === 'second' ? failure('discovery_failed') : success(directory(id), `${id}-log`);
    },
  });
  try {
    const result = await discoverProviders(services.runtime.devices, signal());
    assert.equal(maximum, 1);
    assert.equal(result.data.discovered, 2);
    assert.deepEqual(
      result.data.failures.map((item) => [item.provider, item.logId]),
      [['second', 'log-error']],
    );
    assert.equal(result.logId, 'third-log');
    assert.deepEqual(paths, [
      '/api/v2/device-providers',
      '/api/v2/device-providers/first/refresh',
      '/api/v2/device-providers/second/refresh',
      '/api/v2/device-providers/third/refresh',
    ]);
  } finally {
    await services.dispose();
  }
});

test('取消全量发现立即停止后续提供者调用，不恢复刷新前的选择', async () => {
  const waiting = deferred<Response>();
  const started = deferred<void>();
  const calls: string[] = [];
  const services = createProductServices({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      calls.push(path);
      if (path.endsWith('/device-providers'))
        return success([provider('first'), provider('second')]);
      started.resolve();
      return waiting.promise;
    },
  });
  try {
    const controller = new AbortController();
    const result = discoverProviders(services.runtime.devices, controller.signal);
    const rejected = assert.rejects(result);
    await started.promise;
    controller.abort();
    await rejected;
    waiting.resolve(success(directory('first')));
    assert.equal(
      calls.some((path) => path.includes('/second/')),
      false,
    );
    assert.equal(services.runtime.devices.snapshot().selection, null);
  } finally {
    await services.dispose();
  }
});

test('设备能力接纳任务后等待终态并保留提交和查询日志', async () => {
  const calls: string[] = [];
  const services = createProductServices({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      calls.push(path);
      if (path.endsWith('/device-providers')) return success([provider()]);
      if (path.endsWith('/devices')) return success([directory()]);
      if (path.endsWith('/operations')) return success([operation]);
      if (path.endsWith('/device-actions')) {
        assert.equal(
          init?.body,
          JSON.stringify({
            provider_id: 'example',
            generation: 'g1',
            device_id: 'same',
            capability: 'read',
            version: 1,
            input: { value: 3 },
          }),
        );
        return success({ ...job('device-read'), operation: 'example.read' }, 'submit-log', 202);
      }
      return success(
        {
          ...job('device-read'),
          operation: 'example.read',
          status: 'succeeded',
          result: { result: { value: 3 }, artifacts: [] },
          error: null,
        },
        'query-log',
      );
    },
  });
  try {
    await services.runtime.devices.refreshDirectories(signal());
    await services.runtime.operations.refresh(signal());
    const reference = { providerId: 'example', generation: 'g1', localId: 'same' };
    services.runtime.devices.select(reference);
    const result = await executeCapability(services, reference, read, { value: 3 }, signal());
    assert.equal(result.job.status, 'succeeded');
    assert.equal(result.submitLogId, 'submit-log');
    assert.equal(result.logId, 'query-log');
    assert.deepEqual(result.data, { result: { value: 3 }, artifacts: [] });
    assert.ok(calls.includes('/api/v2/jobs/device-read'));
  } finally {
    await services.dispose();
  }
});

test('任务查询期间切换同名不同提供者设备会撤销等待，晚到终态不交付', async () => {
  const query = deferred<Response>();
  const started = deferred<AbortSignal | null | undefined>();
  const services = createProductServices({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/device-providers')) return success([provider(), provider('other')]);
      if (path.endsWith('/devices')) return success([directory(), directory('other')]);
      if (path.endsWith('/operations')) return success([operation]);
      if (path.endsWith('/device-actions'))
        return success({ ...job('old-read'), operation: 'example.read' }, 'old-submit');
      started.resolve(init?.signal);
      return query.promise;
    },
  });
  try {
    await services.runtime.devices.refreshDirectories(signal());
    await services.runtime.operations.refresh(signal());
    const reference = { providerId: 'example', generation: 'g1', localId: 'same' };
    services.runtime.devices.select(reference);
    let delivered = 0;
    const waiting = executeCapability(services, reference, read, {}, signal()).then((value) => {
      delivered += 1;
      return value;
    });
    const rejected = assert.rejects(waiting);
    const current = await started.promise;
    services.runtime.devices.select({ providerId: 'other', generation: 'g1', localId: 'same' });
    assert.equal(current?.aborted, true);
    await rejected;
    query.resolve(
      success({
        ...job('old-read'),
        operation: 'example.read',
        status: 'succeeded',
        result: 'late-result',
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(delivered, 0);
    assert.equal(services.runtime.devices.snapshot().selection?.providerId, 'other');
  } finally {
    await services.dispose();
  }
});
