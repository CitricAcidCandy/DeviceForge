import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { requestUrl, signal, success } from './fixtures.ts';

const operation = 'plugin.ai-sdk.sdk.stream';
const sessionId = '12345678-1234-1234-1234-123456789abc';
function definitions() {
  return {
    revision: 1,
    sessions: [
      {
        id: operation,
        title: 'SDK实时输出',
        input_schema: { type: 'object' },
        execution: { api_version: 1, source: 'declared', total_timeout_ms: 600000 },
      },
    ],
  };
}
function info(status: 'opening' | 'running' | 'stopping' | 'finished' = 'opening') {
  return {
    id: sessionId,
    operation,
    plugin_id: 'ai-sdk',
    generation: 'generation-1',
    created_at: 1,
    status,
    output_sequence: 0,
    completion: null,
  };
}
function runtime(
  transport: typeof fetch = async (input) => {
    const path = requestUrl(input).pathname;
    if (path.endsWith('/session-definitions')) return success(definitions(), 'definitions-log');
    if (path === '/api/v2/sessions') return success(info(), 'open-log', 202);
    throw new Error(`未授权路径 ${path}`);
  },
) {
  return createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport,
  });
}
async function service(instance: ReturnType<typeof runtime>, input: JsonValue) {
  const access = instance.host.extensions;
  assert.ok(access);
  return access.callService('host.ai-sdk.stream', '1', input, signal());
}

test('runtime通过现有公开插件上下文发现并调用SDK实时服务', async () => {
  const instance = runtime();
  const access = instance.host.extensions;
  assert.ok(access);
  assert.ok(
    access
      .catalog()
      .services.some((entry) => entry.id === 'host.ai-sdk.stream' && entry.version === '1'),
  );
  const definitionsResult = await service(instance, { action: 'definitions' });
  assert.equal(definitionsResult.logId, 'definitions-log');
  assert.deepEqual(definitionsResult.data, definitions());
  const pluginHolder: { context: HostContext | null } = { context: null };
  instance.webPlugins.register({
    id: 'consumer',
    trusted: true,
    plugin: {
      id: 'consumer',
      version: '1',
      apiVersion: 2,
      panels: [],
      activate: async (context) => {
        pluginHolder.context = context;
      },
    },
  });
  await instance.webPlugins.load('consumer');
  const pluginContext = pluginHolder.context;
  assert.ok(pluginContext);
  const pluginAccess = pluginContext.extensions;
  assert.ok(pluginAccess);
  const pluginDefinitions = await pluginAccess.callService(
    'host.ai-sdk.stream',
    '1',
    { action: 'definitions' },
    signal(),
  );
  assert.deepEqual(pluginDefinitions.data, definitions());
  await instance.webPlugins.unload('consumer');
  const opened = await service(instance, {
    action: 'open',
    input: { project_id: 'demo', prompt: '你好' },
  });
  assert.equal(opened.logId, 'open-log');
  assert.deepEqual((opened.data as { data?: unknown }).data ?? opened.data, info());
  const snapshot = await service(instance, { action: 'snapshot' });
  assert.equal((snapshot.data as { session?: { id: string } }).session?.id, sessionId);
  await instance.dispose();
});

test('SDK实时宿主服务严格限制动作、输入字段与有界JSON，不泄露原始异常', async () => {
  const instance = runtime();
  for (const input of [
    { action: 'unknown' },
    { action: 'definitions', extra: '秘密' },
    { action: 'open', input: { project_id: '../demo', prompt: '你好' } },
    { action: 'open', input: { project_id: 'demo', prompt: '   ' } },
    { action: 'resume', id: 'bad', owner: { project_id: 'demo' } },
    { action: 'output', limit: 101 },
  ])
    await assert.rejects(
      service(instance, input),
      (error: unknown) =>
        error instanceof HostError && error.kind === 'protocol' && error.logId === null,
    );
  await instance.dispose();
});

test('SDK实时宿主服务保留公开HTTP日志与错误形状', async () => {
  const instance = runtime(async (input) => {
    if (requestUrl(input).pathname.endsWith('/session-definitions'))
      return new Response(
        JSON.stringify({
          log_id: 'bad-catalog-log',
          error: { code: 'catalog_unavailable', message: '目录暂不可用' },
        }),
        {
          status: 503,
          headers: {
            'content-type': 'application/json',
            'x-deviceforge-log-id': 'bad-catalog-log',
          },
        },
      );
    throw new Error('未授权路径');
  });
  await assert.rejects(
    service(instance, { action: 'definitions' }),
    (error: unknown) =>
      error instanceof HostError &&
      error.kind === 'http' &&
      error.code === 'catalog_unavailable' &&
      error.logId === 'bad-catalog-log' &&
      error.message === '目录暂不可用',
  );
  await instance.dispose();
});

test('runtime关闭立即撤销SDK服务与实时等待，关闭后拒绝新调用', async () => {
  const instance = runtime();
  await service(instance, { action: 'definitions' });
  await instance.dispose();
  await assert.rejects(
    service(instance, { action: 'snapshot' }),
    (error: unknown) =>
      error instanceof HostError && error.kind === 'cancelled' && error.code === 'registry_closed',
  );
  assert.throws(
    () => instance.aiSdkStreaming.refreshDefinitions(signal()),
    (error: unknown) => error instanceof Error && 'kind' in error && error.kind === 'cancelled',
  );
});
