import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { requestUrl, signal, success } from './fixtures.ts';

const threadId = 'abcdef12-1234-1234-1234-123456789abc';
const actions = ['runtime.status', 'sdk.single', 'sdk.turn', 'session.get', 'session.close', 'assistant.run'] as const;
const operation = (action: string) => 'plugin.ai-sdk.' + action;
function definitions() {
  return actions.map((action) => ({ id: operation(action), title: action, input_schema: { type: 'object' } }));
}
function result(action: typeof actions[number]) {
  if (action === 'runtime.status') return {
    provider: 'codex_sdk', sdk_version: '0.162.1', profile: 'codex_sdk_ts_0_162_1_node24', configured: true,
    node_version: '24.14.0', cli_version: '0.162.1', sdk_loaded: true, process_scope_qualified: true,
    model_verified: false, ready: true, projects: ['demo'], reason: null, resource_scope: 'sdk_worker_proxy_and_cli',
  };
  if (action === 'session.get' || action === 'session.close') return {
    provider: 'codex_sdk', sdk_version: '0.162.1', profile: 'codex_sdk_ts_0_162_1_node24',
    project_id: 'demo', thread_id: threadId, turns: '1', closed: action === 'session.close', uncertain: false,
    resource_scope: 'sdk_worker_proxy_and_cli',
  };
  const turns = action === 'sdk.turn' ? '2' : action === 'assistant.run' ? '4' : '1';
  return {
    provider: 'codex_sdk', sdk_version: '0.162.1', project_id: 'demo', thread_id: threadId,
    text: '最终回答', turns, resource_scope: 'sdk_worker_proxy_and_cli',
    ...(action === 'assistant.run' ? { assistant_turns: '4', stream_output: false } : {}),
  };
}
function input(action: typeof actions[number]): JsonValue {
  if (action === 'runtime.status') return {};
  if (action === 'sdk.single') return { project_id: 'demo', prompt: '你好' };
  if (action === 'sdk.turn') return { project_id: 'demo', prompt: '继续', thread_id: threadId };
  if (action === 'session.get' || action === 'session.close') return { project_id: 'demo', thread_id: threadId };
  return { project_id: 'demo', user_prompt: '继续', stream_output: false };
}
function runtime(transport: typeof fetch) {
  return createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport });
}
async function service(instance: ReturnType<typeof runtime>, value: JsonValue) {
  const extensions = instance.host.extensions;
  assert.ok(extensions);
  return extensions.callService('host.ai-sdk', '1', value, signal());
}

test('宿主服务按目录自动装载普通六项SDK并保留最终日志', async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const instance = runtime(async (request, init) => {
    const url = requestUrl(request);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, method: init?.method ?? 'GET', body });
    if (url.pathname.endsWith('/operations')) return success(definitions(), 'catalog-log');
    if (url.pathname === '/api/v2/jobs' && init?.method === 'POST' && typeof body === 'object' && body !== null && 'operation' in body && typeof body.operation === 'string') {
      const action = body.operation.replace('plugin.ai-sdk.', '') as typeof actions[number];
      return success({ id: 'job-' + calls.length, operation: body.operation, input: 'input' in body ? body.input : {}, created_at: 1,
        status: 'succeeded', result: { result: result(action), artifacts: [] } }, 'job-log', 200);
    }
    throw new Error('未授权路径 ' + url.pathname);
  });
  const access = instance.host.extensions;
  assert.ok(access);
  assert.ok(access.catalog().services.some((entry) => entry.id === 'host.ai-sdk' && entry.version === '1'));
  for (const action of actions) {
    const request = action === 'runtime.status' ? { action } : { action, input: input(action) };
    const response = await service(instance, request);
    assert.equal(response.logId, 'job-log');
    assert.deepEqual(response.data, result(action));
  }
  assert.equal(calls.filter((call) => call.path.endsWith('/operations')).length, 1);
  assert.equal(calls.filter((call) => call.path === '/api/v2/jobs').length, actions.length);
  await instance.dispose();
});

test('普通SDK服务沿插件上下文代次调用，卸载后旧上下文失效', async () => {
  const instance = runtime(async (request, init) => {
    const path = requestUrl(request).pathname;
    if (path.endsWith('/operations')) return success(definitions(), 'catalog-log');
    if (path === '/api/v2/jobs' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { operation: string };
      const action = body.operation.replace('plugin.ai-sdk.', '') as typeof actions[number];
      return success({ id: 'job-plugin', operation: body.operation, input: {}, created_at: 1, status: 'succeeded', result: { result: result(action), artifacts: [] } }, 'job-plugin-log');
    }
    throw new Error('未授权路径 ' + path);
  });
  const holder: { context: HostContext | null } = { context: null };
  instance.webPlugins.register({ id: 'consumer', trusted: true, plugin: {
    id: 'consumer', version: '1', apiVersion: 2, panels: [],
    activate: async (context) => { holder.context = context; },
  } });
  await instance.webPlugins.load('consumer');
  const pluginContext = holder.context;
  assert.ok(pluginContext?.extensions);
  const pluginExtensions = pluginContext.extensions;
  const response = await pluginExtensions.callService('host.ai-sdk', '1', { action: 'runtime.status' }, signal());
  assert.equal(response.logId, 'job-plugin-log');
  await instance.webPlugins.unload('consumer');
  assert.throws(() => pluginExtensions.callService('host.ai-sdk', '1', { action: 'runtime.status' }, signal()), (error: unknown) => error instanceof HostError && error.code === 'extension_revoked');
  await instance.dispose();
});

test('普通SDK服务拒绝非法动作和输入且不提交任务，服务错误保留日志', async () => {
  let jobs = 0;
  const instance = runtime(async (request, init) => {
    const path = requestUrl(request).pathname;
    if (path.endsWith('/operations')) return success(definitions(), 'catalog-log');
    if (path === '/api/v2/jobs' && init?.method === 'POST') { jobs++; return success({}, 'unexpected'); }
    throw new Error('未授权路径 ' + path);
  });
  await assert.rejects(service(instance, { action: 'unknown' }), (error: unknown) => error instanceof HostError && error.kind === 'protocol' && error.logId === null);
  await assert.rejects(service(instance, { action: 'runtime.status', input: {}, extra: 'secret' }), (error: unknown) => error instanceof HostError && error.kind === 'protocol' && error.logId === null);
  await service(instance, { action: 'sdk.single', input: { project_id: 'demo', prompt: '   ' } }).catch(() => undefined);
  await assert.rejects(service(instance, { action: 'sdk.single', input: { project_id: 'demo', prompt: '   ' } }), (error: unknown) => error instanceof HostError && error.kind === 'protocol');
  assert.equal(jobs, 0);
  const failing = runtime(async (request) => requestUrl(request).pathname.endsWith('/operations')
    ? new Response(JSON.stringify({ log_id: 'catalog-error-log', error: { code: 'catalog_unavailable', message: '目录暂不可用' } }), { status: 503, headers: { 'content-type': 'application/json', 'x-deviceforge-log-id': 'catalog-error-log' } })
    : new Response('unexpected', { status: 500 }));
  await assert.rejects(service(failing, { action: 'runtime.status' }), (error: unknown) => error instanceof HostError && error.kind === 'http' && error.code === 'catalog_unavailable' && error.logId === 'catalog-error-log');
  await instance.dispose(); await failing.dispose();
});

test('runtime关闭后普通SDK服务和SDK实例均不可用', async () => {
  const instance = runtime(async (request) => requestUrl(request).pathname.endsWith('/operations') ? success(definitions(), 'catalog-log') : new Response('unexpected', { status: 500 }));
  await instance.dispose();
  await assert.rejects(service(instance, { action: 'runtime.status' }), (error: unknown) => error instanceof HostError && error.code === 'registry_closed');
  assert.throws(() => instance.aiSdk.runtimeStatus(signal()), (error: unknown) => typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'cancelled');
});
