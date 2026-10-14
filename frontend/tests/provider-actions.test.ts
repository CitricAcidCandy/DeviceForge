import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DeviceAccess, DeviceAction } from '../src/plugin-sdk/index.ts';
import type { DeviceDirectoryDto, DeviceProviderDto } from '../src/services/api/index.ts';
import { directory, provider } from './device-fixtures.ts';
import { deferred, job, requestUrl, signal, success } from './fixtures.ts';

function networkProvider(generation = 'g1'): DeviceProviderDto {
  const source = provider('example', generation);
  return { ...source, definition: { ...source.definition, api_version: 3, capabilities: [
    ...source.definition.capabilities,
    { id: 'connect', version: 1, operation: 'example.connect', scope: 'provider', access: 'write', execution_timeout_ms: 30000 },
    { id: 'disconnect', version: 1, operation: 'example.disconnect', scope: 'provider', access: 'write', execution_timeout_ms: 30000 },
  ] } };
}
function observedDirectory(localIds = ['same', 'other']): DeviceDirectoryDto {
  return { ...directory('example', 'g1', localIds), provider: networkProvider() };
}
function providerAction(capability = 'connect', overrides: Partial<DeviceAction> = {}): DeviceAction {
  return { providerId: 'example', generation: 'g1', deviceId: null, capability, version: 1, input: { address: 'localhost:5555' }, ...overrides };
}
function deviceHost(value: DeviceAccess | undefined): DeviceAccess { assert.ok(value); return value; }

test('没有设备目录或选择也可调用提供者连接与断开，显式null和地址原样映射', async () => {
  const requests: string[] = []; let actionRequests = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async (input, init) => {
    const path = requestUrl(input).pathname; requests.push(`${init?.method} ${path}`);
    if (path === '/api/v2/device-providers') return success([networkProvider()]);
    assert.equal(path, '/api/v2/device-actions'); ++actionRequests;
    const capability = actionRequests === 1 ? 'connect' : 'disconnect';
    assert.equal(init?.body, JSON.stringify({ provider_id: 'example', generation: 'g1', device_id: null, capability, version: 1, input: { address: 'localhost:5555' } }));
    return success({ ...job('provider-' + capability), operation: 'example.' + capability, status: 'succeeded',
      result: { result: { output: capability === 'connect' ? 'Connect OK' : '' }, artifacts: [] },
    }, 'provider-action-log', 202);
  } });
  try {
    const host = deviceHost(runtime.host.devices); await host.refreshProviders(signal());
    assert.deepEqual(host.snapshot().directories, []); assert.equal(host.snapshot().selection, null);
    for (const capability of ['connect', 'disconnect']) {
      const result = await host.invoke(providerAction(capability), signal());
      assert.equal(result.logId, 'provider-action-log'); assert.equal(result.data.status, 'succeeded');
      assert.deepEqual(result.data.result, { result: { output: capability === 'connect' ? 'Connect OK' : '' }, artifacts: [] });
      assert.deepEqual(host.snapshot().directories, []); assert.equal(host.snapshot().selection, null);
    }
    assert.equal(actionRequests, 2);
    assert.deepEqual(requests, ['GET /api/v2/device-providers', 'POST /api/v2/device-actions', 'POST /api/v2/device-actions']);
  } finally { await runtime.dispose(); }
});

test('提供者动作必须使用显式null，空串、地址或现有设备身份均本地拒绝且零动作请求', async () => {
  let actionRequests = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async (input) => {
    const path = requestUrl(input).pathname;
    if (path === '/api/v2/device-providers') return success([networkProvider()]);
    if (path.endsWith('/refresh')) return success(observedDirectory());
    ++actionRequests; return success(job());
  } });
  try {
    const host = deviceHost(runtime.host.devices); await host.refreshProviders(signal());
    await host.refreshProvider('example', 'g1', signal());
    for (const capability of ['connect', 'disconnect']) {
      for (const deviceId of ['', 'localhost:5555', 'same']) {
        await assert.rejects(host.invoke(providerAction(capability, { deviceId }), signal()), (error: unknown) =>
          error instanceof HostError && error.kind === 'protocol' && error.code === 'invalid_input' && error.status === 400 && error.logId === null);
      }
    }
    assert.equal(actionRequests, 0);
  } finally { await runtime.dispose(); }
});

test('提供者换代撤销在途动作，旧代引用拒绝，新代调用不接收旧响应', { timeout: 5000 }, async () => {
  let generation = 'g1'; let actionRequests = 0; let deliveries = 0;
  const response = deferred<Response>(); const started = deferred<AbortSignal | null | undefined>();
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async (input, init) => {
    const path = requestUrl(input).pathname;
    if (path === '/api/v2/device-providers') return success([networkProvider(generation)]);
    assert.equal(path, '/api/v2/device-actions'); ++actionRequests;
    if (actionRequests === 1) { started.resolve(init?.signal); return response.promise; }
    assert.equal(init?.body, JSON.stringify({ provider_id: 'example', generation: 'g2', device_id: null, capability: 'connect', version: 1, input: { address: 'localhost:5555' } }));
    return success(job('new-generation'));
  } });
  try {
    const host = deviceHost(runtime.host.devices); await host.refreshProviders(signal());
    const waiting = host.invoke(providerAction(), signal()).then((result) => { ++deliveries; return result; });
    const rejected = assert.rejects(waiting, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
    const httpSignal = await started.promise; generation = 'g2'; await host.refreshProviders(signal());
    assert.equal(httpSignal?.aborted, true); await rejected;
    await assert.rejects(host.invoke(providerAction(), signal()), (error: unknown) =>
      error instanceof HostError && error.code === 'conflict' && error.status === 409);
    assert.equal(actionRequests, 1); response.resolve(success(job('old-generation-late')));
    const result = await host.invoke(providerAction('connect', { generation: 'g2' }), signal());
    assert.equal(result.data.id, 'new-generation'); assert.equal(deliveries, 0); assert.equal(actionRequests, 2);
    assert.deepEqual(host.snapshot().directories, []);
  } finally { response.resolve(success(job('old-generation-late'))); await runtime.dispose(); }
});

test('caller取消结束提供者动作等待，忽略信号的晚到响应不交付、不重提或自动取消服务器Job', { timeout: 5000 }, async () => {
  const requests: string[] = []; let deliveries = 0;
  const response = deferred<Response>(); const started = deferred<AbortSignal | null | undefined>();
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async (input, init) => {
    const path = requestUrl(input).pathname; requests.push(`${init?.method} ${path}`);
    if (path === '/api/v2/device-providers') return success([networkProvider()]);
    assert.equal(path, '/api/v2/device-actions'); started.resolve(init?.signal); return response.promise;
  } });
  try {
    const host = deviceHost(runtime.host.devices); await host.refreshProviders(signal());
    const caller = new AbortController();
    const waiting = host.invoke(providerAction(), caller.signal).then((result) => { ++deliveries; return result; });
    const rejected = assert.rejects(waiting, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
    const httpSignal = await started.promise; caller.abort();
    assert.equal(httpSignal?.aborted, true); await rejected;
    response.resolve(success(job('cancelled-wait-late')));
    await host.refreshProviders(signal());
    assert.equal(deliveries, 0); assert.deepEqual(host.snapshot().directories, []);
    assert.deepEqual(requests, ['GET /api/v2/device-providers', 'POST /api/v2/device-actions', 'GET /api/v2/device-providers']);
  } finally { response.resolve(success(job('cancelled-wait-late'))); await runtime.dispose(); }
});

test('提供者断开完成不自动刷新或删除旧观测，显式刷新后才撤销设备选择', async () => {
  let disconnected = false; let refreshRequests = 0;
  const requests: string[] = [];
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async (input, init) => {
    const path = requestUrl(input).pathname; requests.push(`${init?.method} ${path}`);
    if (path === '/api/v2/device-providers') return success([networkProvider()]);
    if (path.endsWith('/refresh')) { ++refreshRequests; return success(observedDirectory(disconnected ? [] : ['same'])); }
    assert.equal(path, '/api/v2/device-actions'); disconnected = true;
    return success({ ...job('disconnect-completed'), status: 'succeeded', result: { result: { output: '' }, artifacts: [] } });
  } });
  try {
    const host = deviceHost(runtime.host.devices); await host.refreshProviders(signal());
    await host.refreshProvider('example', 'g1', signal());
    host.select({ providerId: 'example', generation: 'g1', localId: 'same' });
    const before = host.snapshot();
    const result = await host.invoke(providerAction('disconnect'), signal());
    assert.equal(result.data.status, 'succeeded'); assert.deepEqual(result.data.result, { result: { output: '' }, artifacts: [] });
    assert.deepEqual(host.snapshot(), before); assert.equal(refreshRequests, 1);
    assert.deepEqual(requests, ['GET /api/v2/device-providers', 'POST /api/v2/device-providers/example/refresh', 'POST /api/v2/device-actions']);
    const refreshed = await host.refreshProvider('example', 'g1', signal());
    assert.deepEqual(refreshed.data.devices, []); assert.equal(refreshRequests, 2);
    assert.deepEqual(host.snapshot().directories[0]?.devices, []); assert.equal(host.snapshot().selection, null);
  } finally { await runtime.dispose(); }
});

test('切换设备选择不撤销提供者动作，动作完成保留新选择', { timeout: 5000 }, async () => {
  const response = deferred<Response>(); const started = deferred<AbortSignal | null | undefined>();
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async (input, init) => {
    const path = requestUrl(input).pathname;
    if (path === '/api/v2/device-providers') return success([networkProvider()]);
    if (path.endsWith('/refresh')) return success(observedDirectory());
    assert.equal(path, '/api/v2/device-actions'); started.resolve(init?.signal); return response.promise;
  } });
  try {
    const host = deviceHost(runtime.host.devices); await host.refreshProviders(signal());
    await host.refreshProvider('example', 'g1', signal()); host.select({ providerId: 'example', generation: 'g1', localId: 'same' });
    const waiting = host.invoke(providerAction(), signal());
    const httpSignal = await started.promise; host.select({ providerId: 'example', generation: 'g1', localId: 'other' });
    assert.equal(httpSignal?.aborted, false);
    response.resolve(success({ ...job('provider-completed'), status: 'succeeded' }));
    assert.equal((await waiting).data.id, 'provider-completed');
    assert.equal(host.snapshot().selection?.localId, 'other'); assert.equal(httpSignal?.aborted, false);
  } finally { response.resolve(success(job('provider-completed'))); await runtime.dispose(); }
});
