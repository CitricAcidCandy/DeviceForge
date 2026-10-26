import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { dependenciesView, dependency } from './plugin-dependencies-fixtures.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

function runtime(transport: typeof fetch) {
  return createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport });
}
function invoke(instance: ReturnType<typeof runtime>, value: JsonValue, caller = signal()) {
  assert.ok(instance.host.extensions);
  return instance.host.extensions.callService('host.plugin-dependencies', '1', value, caller);
}

test('公开依赖服务按版本1登记，构造零请求，三类目标只 GET 并保留 canonical 与日志，不检测浏览器环境或下载', async () => {
  const requests: string[] = [];
  const instance = runtime(async (input, init) => {
    const path = requestUrl(input).pathname;
    requests.push(path);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    return success(dependenciesView(), 'public-dependency-log');
  });
  try {
    assert.deepEqual(requests, []);
    assert.ok(instance.host.extensions?.catalog().services.some((item) => item.id === 'host.plugin-dependencies' && item.version === '1'));
    for (const kind of ['release', 'server', 'browser']) {
      const result = await invoke(instance, { action: 'get', target: { kind, id: 'example' } });
      assert.deepEqual(result.data, dependenciesView());
      assert.equal(result.logId, 'public-dependency-log');
    }
    assert.deepEqual(requests, ['/api/v2/plugin-dependencies/release/example',
      '/api/v2/plugin-dependencies/server/example', '/api/v2/plugin-dependencies/browser/example']);
  } finally { await instance.dispose(); }
});

test('依赖服务拒绝未知动作、额外字段及无效目标，全部在网络前拒绝，不以标准提交任务猜测查询操作', async () => {
  let requests = 0;
  const instance = runtime(async () => { ++requests; throw new Error('非法请求不应发送'); });
  const target = { kind: 'browser', id: 'example' };
  const invalid: JsonValue[] = [null, [], {}, { action: 'get' }, { action: 'scan', target },
    { action: 'install', target }, { action: 'get', target, download: true },
    { action: 'get', target: null }, { action: 'get', target: [] },
    { action: 'get', target: { ...target, path: 'tool' } },
    { action: 'get', target: { kind: 'device', id: 'example' } },
    ...['', '../example', 'Upper', 'builtin.tool', '_bad', 'a'.repeat(100)].map((id) => ({ action: 'get', target: { ...target, id } })),
  ];
  try {
    for (const value of invalid) await assert.rejects(invoke(instance, value),
      (error: unknown) => error instanceof HostError && error.code === 'invalid_plugin_dependencies_request');
    assert.equal(requests, 0);
    assert.ok(instance.host.extensions);
    assert.throws(() => instance.host.extensions?.callService('host.plugin-dependencies', '2', { action: 'get', target }, signal()),
      (error: unknown) => error instanceof HostError && error.code === 'service_unavailable');
    assert.equal(requests, 0);
  } finally { await instance.dispose(); }
});

test('依赖服务保留 HTTP 状态、日志和重试间隔，协议响应失败不伪造就绪', async () => {
  let response: () => Response = () => new Response(JSON.stringify({ ok: false,
    error: { code: 'dependencies_busy', message: '工具正在使用' }, log_id: 'busy-log' }),
  { status: 409, headers: { 'content-type': 'application/json', 'retry-after': '2' } });
  const instance = runtime(async () => response());
  try {
    await assert.rejects(invoke(instance, { action: 'get', target: { kind: 'browser', id: 'example' } }),
      (error: unknown) => error instanceof HostError && error.code === 'dependencies_busy' &&
        error.status === 409 && error.logId === 'busy-log' && error.retryAfter === '2');
    response = () => success({ ready: true }, 'broken-log');
    await assert.rejects(invoke(instance, { action: 'get', target: { kind: 'browser', id: 'example' } }),
      (error: unknown) => error instanceof HostError && error.kind === 'protocol' && error.logId === 'broken-log');
    response = () => failure('not_configured', 503);
    await assert.rejects(invoke(instance, { action: 'get', target: { kind: 'browser', id: 'example' } }),
      (error: unknown) => error instanceof HostError && error.code === 'not_configured');
  } finally { await instance.dispose(); }
});

test('已安装浏览器插件从公开 extensions 查询，插件撤销取消忽略信号的在途 GET，不泄漏到新代', async () => {
  const entered = deferred<void>(), late = deferred<Response>();
  const contexts: HostContext[] = [];
  const instance = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (_input, init) => {
      assert.equal(init?.method, 'GET');
      entered.resolve();
      return late.promise;
    },
    esmImporter: async () => ({ default: { id: 'consumer', version: '1.0', apiVersion: 2, panels: [],
      activate: async (value: HostContext) => { contexts.push(value); },
    } }),
  });
  try {
    instance.registerInstalledPackage({ id: 'consumer', version: '1.0', entryPath: 'index.js' });
    await instance.webPlugins.load('consumer');
    const host = contexts[0];
    assert.ok(host);
    assert.ok(host.extensions);
    const pending = host.extensions.callService('host.plugin-dependencies', '1', {
      action: 'get', target: { kind: 'browser', id: 'consumer' },
    }, signal());
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
    await entered.promise;
    await instance.webPlugins.unload('consumer');
    await rejected;
    late.resolve(success(dependenciesView({ target: { kind: 'browser', id: 'consumer' }, dependencies: [], ready: true })));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(instance.webPlugins.snapshot(), []);
  } finally { await instance.dispose(); }
});

test('依赖服务查询结果与源视图隔离，无依赖和可选缺失仍以宿主 ready 为准', async () => {
  const instance = runtime(async () => success(dependenciesView({ ready: true, dependencies: [dependency({ required: false })] })));
  try {
    const result = await invoke(instance, { action: 'get', target: { kind: 'release', id: 'example' } });
    assert.ok(result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data));
    result.data.ready = false;
    const next = await invoke(instance, { action: 'get', target: { kind: 'release', id: 'example' } });
    assert.ok(next.data !== null && typeof next.data === 'object' && !Array.isArray(next.data));
    assert.equal(next.data.ready, true);
  } finally { await instance.dispose(); }
});
