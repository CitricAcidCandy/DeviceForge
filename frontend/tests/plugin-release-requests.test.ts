import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductServices } from '../src/app/product/services.ts';
import { createReleaseRequestClient } from '../src/app/release-requests.ts';
import { createTasks } from '../src/features/tasks/index.ts';
import { ApiError, createApiClient, deviceActionEndpoint, refreshDeviceProviderEndpoint, withPluginRelease, withRequestHeaders } from '../src/services/api/index.ts';
import { deferred, failure, job, requestUrl, signal, success } from './fixtures.ts';
import { release } from './plugin-installations-fixture.ts';

const revision = 'a'.repeat(64);
const header = JSON.stringify({ id: 'example-release', revision });

function installedDto() {
  const value = release(true);
  return { id: value.id, name: value.name, description: value.description, version: value.version,
    revision: value.revision, enabled: value.enabled, status: value.status, installed_at: 1,
    tools: [], requirements: [], components: value.components.map((component) => ({
      id: component.id, kind: component.kind, version: component.version, revision: component.revision,
      entry_path: component.entryPath, entry_url: component.entryUrl,
    })) };
}

test('产品任务在提交钩子之后解析发布身份，保留令牌且不改业务输入', async () => {
  const requests: string[] = [];
  const client = createReleaseRequestClient(createApiClient({ baseUrl: 'http://localhost:7031',
    tokenProvider: () => 'test-token', transport: async (input, init) => {
      requests.push(requestUrl(input).pathname);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
      assert.equal(new Headers(init?.headers).get('x-deviceforge-plugin-release'), header);
      assert.deepEqual(JSON.parse(String(init?.body)), { operation: 'plugin.example-server.changed', input: { original: true } });
      return success(job(), 'task-release-log');
    } }), { installations: async () => [release(true)], plugins: () => [] });
  const tasks = createTasks(client, async (value) => ({ ...value, operation: 'plugin.example-server.changed' }));
  try {
    const result = await tasks.submit({ operation: 'unowned.initial', input: { original: true } }, signal());
    assert.equal(result.logId, 'task-release-log');
    assert.deepEqual(requests, ['/api/v2/jobs']);
  } finally { tasks.dispose(); }
});

test('产品会话复用发布感知客户端，构造与无所属请求不额外查询安装目录', async () => {
  const requests: string[] = [];
  const services = createProductServices({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      requests.push(path);
      if (path === '/api/v2/plugin-installations') return success([installedDto()]);
      if (path === '/api/v2/session-definitions') return success({ revision: 1, sessions: [{
        id: 'plugin.example-server.open', title: '示例会话', input_schema: { type: 'object' },
        execution: { api_version: 1, source: 'declared', total_timeout_ms: 60_000 },
      }] });
      if (path === '/api/v2/sessions') {
        assert.equal(new Headers(init?.headers).get('x-deviceforge-plugin-release'), header);
        assert.deepEqual(JSON.parse(String(init?.body)), { operation: 'plugin.example-server.open', input: {} });
        return success({ id: '12345678-1234-1234-1234-123456789abc', operation: 'plugin.example-server.open', plugin_id: 'example-server',
          generation: 'g1', created_at: 1, status: 'opening', output_sequence: 0, completion: null }, 'session-release-log');
      }
      assert.equal(path, '/api/v2/jobs');
      assert.equal(new Headers(init?.headers).get('x-deviceforge-plugin-release'), null);
      return success(job());
    } });
  try {
    assert.deepEqual(requests, []);
    await services.runtime.tasks.submit({ operation: 'unowned.run', input: null }, signal());
    assert.deepEqual(requests, ['/api/v2/jobs']);
    await services.runtime.pluginInstallations.refresh(signal());
    await services.sessions.refreshDefinitions(signal());
    const opened = await services.sessions.open({ operation: 'plugin.example-server.open', input: {} }, signal());
    assert.equal(opened.logId, 'session-release-log');
    assert.deepEqual(requests, ['/api/v2/jobs', '/api/v2/plugin-installations', '/api/v2/session-definitions', '/api/v2/sessions']);
  } finally { await services.dispose(); }
});

test('设备动作与提供者刷新按真实服务器组件携带修订', async () => {
  const client = createReleaseRequestClient(createApiClient({ baseUrl: 'http://localhost:7031', transport: async (input, init) => {
    assert.equal(new Headers(init?.headers).get('x-deviceforge-plugin-release'), header);
    if (requestUrl(input).pathname === '/api/v2/device-actions') return success(job());
    return success({ provider: { id: 'example-server', generation: 'g1', version: '1.0', definition: {
      api_version: 1, platform: '测试平台', discover_operation: 'discover', capabilities: [],
    } }, observed_at: 1, discovery_job_id: 'discovery', devices: [] });
  } }), { installations: async () => [release(true)], plugins: () => [] });
  await client.call(deviceActionEndpoint, { provider_id: 'example-server', generation: 'g1', device_id: null,
    capability: 'read', version: 1, input: {} }, signal());
  await client.call(refreshDeviceProviderEndpoint, { id: 'example-server', generation: 'g1' }, signal());
});

test('浏览器客户端固定加载时修订，目录更新后旧代码仍被服务器拒绝并保留日志', async () => {
  const reference = { id: 'example-release', revision };
  const client = withPluginRelease(createApiClient({ baseUrl: 'http://localhost:7031', transport: async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('x-deviceforge-plugin-release'), header);
    return failure('stale_release');
  } }), reference);
  reference.revision = 'b'.repeat(64);
  const tasks = createTasks(client);
  try {
    await assert.rejects(tasks.submit({ operation: 'plugin.example-server.run', input: null }, signal()),
      (reason: unknown) => reason instanceof ApiError && reason.status === 409 && reason.logId === 'log-error');
  } finally { tasks.dispose(); }
});

test('发布头解析取消及时结束等待，晚到身份不发送网络且保留公开取消错误', async () => {
  const waiting = deferred<Readonly<Record<string, string>>>();
  const controller = new AbortController();
  let requests = 0;
  const client = withRequestHeaders(createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => {
    ++requests; return success(job());
  } }), () => waiting.promise);
  const tasks = createTasks(client);
  try {
    const pending = tasks.get('cancelled-job', controller.signal);
    controller.abort();
    await assert.rejects(pending, (reason: unknown) => reason instanceof ApiError && reason.kind === 'cancelled');
    waiting.resolve({ 'x-deviceforge-plugin-release': header });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 0);
  } finally { tasks.dispose(); }
});
