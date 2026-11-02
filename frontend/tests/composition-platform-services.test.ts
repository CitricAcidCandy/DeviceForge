import test from 'node:test';
import assert from 'node:assert/strict';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { Dispose, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { McpSnapshot } from '../src/features/mcp/index.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import { registerPlatformServices } from '../src/app/composition/platform-services.ts';

function fixture() {
  const controller = new AbortController(), registry = createExtensionRegistry();
  const releases = new Set<Dispose>();
  const host: HostContext = {
    apiVersion: 2, signal: controller.signal,
    onDispose: (release) => { releases.add(release); return release; },
    listOperations: async () => ({ data: [], logId: null }),
    subscribeOperations: () => () => undefined,
    submit: async () => { throw new Error('不应提交业务任务'); },
    getJob: async () => { throw new Error('不应查询业务任务'); },
    cancelJob: async () => { throw new Error('不应取消业务任务'); },
  };
  return {
    controller, host, extensions: registry,
    async call(id: string, input: JsonValue, signal = controller.signal) {
      return registry.callService(id, '1', input, signal);
    },
    async dispose() {
      controller.abort();
      for (const release of [...releases].reverse()) await release();
      await registry.dispose();
    },
  };
}
test('未注入的能力不注册，不建立连接或 MCP 管理器', async () => {
  const root = fixture();
  const release = registerPlatformServices(root, {});
  assert.deepEqual(root.extensions.catalog().services, []);
  await assert.rejects(root.call('host.connection', { action: 'status' }), { code: 'service_unavailable' });
  await release(); await root.dispose();
});
test('只读连接报告不可切换，未知参数与无效地址不调用连接副作用', async () => {
  const root = fixture();
  registerPlatformServices(root, { connection: { baseUrl: 'http://127.0.0.1:7031' } });
  assert.deepEqual((await root.call('host.connection', { action: 'status' })).data, {
    baseUrl: 'http://127.0.0.1:7031', canReconnect: false,
  });
  await assert.rejects(root.call('host.connection', { action: 'reconnect', baseUrl: 'http://localhost', token: '' }), {
    code: 'connection_reconnect_unavailable',
  });
  await root.dispose();
  const writable = fixture(); let calls = 0;
  registerPlatformServices(writable, { connection: {
    baseUrl: 'http://localhost:7031', reconnect: async () => { calls++; },
  } });
  const invalidInputs: readonly JsonValue[] = [
    { action: 'status', token: '不应接受' },
    { action: 'reconnect', baseUrl: 'file:///C:/server', token: '' },
    { action: 'reconnect', baseUrl: 'http://user:secret@localhost', token: '' },
    { action: 'reconnect', baseUrl: 'http://localhost?token=secret', token: '' },
    { action: 'reconnect', baseUrl: 'http://localhost', token: 1 },
    { action: 'reconnect', baseUrl: 'http://localhost', token: '', repeat: true },
  ];
  for (const input of invalidInputs) await assert.rejects(writable.call('host.connection', input));
  assert.equal(calls, 0);
  await writable.dispose();
});
test('连接切换仅调用注入入口，成功后读取真实当前地址，不返回令牌', async () => {
  const root = fixture();
  let address = 'http://localhost:7031', calls = 0;
  registerPlatformServices(root, { connection: {
    get baseUrl() { return address; },
    reconnect: async (url, token, signal) => {
      signal.throwIfAborted(); calls++; assert.equal(token, '测试令牌'); address = url;
      return { logId: 'connection-log' };
    },
  } });
  const result = await root.call('host.connection', { action: 'reconnect', baseUrl: 'http://localhost:8031/', token: '测试令牌' });
  assert.equal(calls, 1); assert.equal(result.logId, 'connection-log');
  assert.deepEqual(result.data, { baseUrl: 'http://localhost:8031', canReconnect: true });
  assert.equal(JSON.stringify(result).includes('测试令牌'), false);
  await root.dispose();
});

test('现有 MCP 目录与日志经公开服务返回，不启动长期订阅或其他请求', async () => {
  const root = fixture();
  let calls = 0, subscriptions = 0;
  const observed: { signal: AbortSignal | null } = { signal: null };
  const client = {
    async listTools(signal: AbortSignal) {
      calls++; observed.signal = signal;
      return { tools: [{
        name: 'read_config', title: '读取配置', description: '查看当前配置',
        inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' },
        annotations: { readOnlyHint: true }, meta: { version: 1 },
      }], logId: 'mcp-log', version: 1 };
    },
    async subscribe() { subscriptions++; throw new Error('不能用有限服务调用启动长期订阅'); },
  };
  const release = registerPlatformServices(root, { mcp: client });
  assert.equal(calls, 0); assert.equal(subscriptions, 0);
  assert.deepEqual(root.extensions.catalog().services.map((entry) => entry.id), ['host.mcp']);
  const result = await root.call('host.mcp', { action: 'listTools' });
  assert.equal(calls, 1); assert.equal(subscriptions, 0);
  assert.equal(result.logId, 'mcp-log');
  assert.deepEqual(result.data, { tools: [{
    name: 'read_config', title: '读取配置', description: '查看当前配置',
    inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true }, meta: { version: 1 },
  }] });
  assert.ok(observed.signal);
  assert.equal(observed.signal.aborted, true);
  await release();
  await assert.rejects(root.call('host.mcp', { action: 'listTools' }), { code: 'service_unavailable' });
  await root.dispose();
});

test('MCP 参数先校验，原 API 错误的状态、日志和重试提示保留', async () => {
  const root = fixture(); let calls = 0;
  registerPlatformServices(root, { mcp: { listTools: async () => {
    calls++; throw new ApiError('http', 'mcp_unavailable', '原 MCP 客户端响应不可用', 503, 'upstream-log', '2');
  } } });
  await assert.rejects(root.call('host.mcp', { action: 'subscribe' }));
  await assert.rejects(root.call('host.mcp', { action: 'listTools', subscribe: true }));
  assert.equal(calls, 0);
  await assert.rejects(root.call('host.mcp', { action: 'listTools' }), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, 'mcp_unavailable'); assert.equal(error.status, 503);
    assert.equal(error.logId, 'upstream-log'); assert.equal(error.retryAfter, '2');
    return true;
  });
  assert.equal(calls, 1);
  await root.dispose();
});

test('MCP 忽略取消时等待仍结束，晚到结果不冒充成功；后续独立调用继续', async () => {
  const root = fixture();
  let calls = 0;
  let finish: (value: McpSnapshot) => void = () => undefined;
  registerPlatformServices(root, { mcp: { listTools: async () => {
    calls++;
    if (calls === 1) return new Promise<McpSnapshot>((resolve) => { finish = resolve; });
    return { tools: [], logId: 'new-log', version: 2 };
  } } });
  await assert.rejects(root.call('host.mcp', { action: 'listTools' }, AbortSignal.timeout(8)), (error: unknown) =>
    error instanceof HostError && error.kind === 'cancelled');
  finish({ tools: [], logId: 'old-log', version: 1 });
  const result = await root.call('host.mcp', { action: 'listTools' });
  assert.equal(calls, 2); assert.equal(result.logId, 'new-log');
  assert.deepEqual(result.data, { tools: [] });
  await root.dispose();
});

test('网络失败的切换只调用一次并保留原日志，不生成成功回执', async () => {
  const root = fixture(); let calls = 0;
  registerPlatformServices(root, { connection: {
    baseUrl: 'http://localhost:7031',
    reconnect: async () => { calls++; throw new ApiError('network', 'connection_unknown', '切换结果未确认', null, 'switch-log'); },
  } });
  await assert.rejects(root.call('host.connection', {
    action: 'reconnect', baseUrl: 'http://localhost:8031', token: '',
  }), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, 'connection_unknown'); assert.equal(error.logId, 'switch-log');
    return true;
  });
  assert.equal(calls, 1);
  await root.dispose();
});
test('已取消输入不执行切换，切换结果未知不自动重放或冒称完成', async () => {
  const root = fixture();
  let calls = 0;
  let finish: () => void = () => undefined;
  registerPlatformServices(root, { connection: {
    baseUrl: 'http://localhost:7031',
    reconnect: async () => { calls++; return new Promise<void>((resolve) => { finish = resolve; }); },
  } });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(root.call('host.connection', {
    action: 'reconnect', baseUrl: 'http://localhost:8031', token: '',
  }, cancelled.signal), (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
  assert.equal(calls, 0);
  const caller = new AbortController();
  const pending = root.call('host.connection', { action: 'reconnect', baseUrl: 'http://localhost:8031', token: '' }, caller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  caller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.deepEqual((await root.call('host.connection', { action: 'status' })).data, {
    baseUrl: 'http://localhost:7031', canReconnect: true,
  });
  await root.dispose();
});
