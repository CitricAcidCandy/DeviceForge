import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { registerLegacyServiceAliases } from '../src/app/composition/legacy-service-aliases.ts';
import { deferred, job, requestUrl, success } from './fixtures.ts';
import type { HostContext, HostResult, JsonValue, ServiceRef } from '../src/plugin-sdk/index.ts';

const parser = registerCompositionStartupImports();
after(parser.dispose);
const { default: createAiPlugin } = await import('../plugins/ai/src/index.ts');
const { default: createPerformancePlugin } = await import('../plugins/performance/src/index.ts');
const baseUrl = 'http://127.0.0.1:7031';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++) await turn();
  assert.ok(predicate(), '本次服务状态未在有界单元夹具内收敛');
}
function has(context: HostContext, ref: ServiceRef) {
  return context.services?.catalog().some((entry) => entry.service.id === ref.id && entry.service.version === ref.version && entry.available) ?? false;
}
function call(context: HostContext, ref: ServiceRef, input: JsonValue, signal = context.signal) {
  const services = context.services;
  assert.ok(services);
  return services.call(ref, input, signal);
}

test('默认运行时不创建旧业务服务，缺失插件时旧名称明确不可用', async () => {
  let requests = 0;
  const runtime = createFrontendRuntime({ baseUrl, workspaceStorage: null, panelTarget: () => null,
    transport: async () => { requests++; throw new Error('禁止隐式联网'); } });
  try {
    assert.equal(has(runtime.host, { id: 'host.ai-sdk', version: '1' }), false);
    assert.equal(has(runtime.host, { id: 'host.performance', version: '1' }), false);
    await assert.rejects(async () => call(runtime.host, { id: 'host.ai-sdk', version: '1' }, { action: 'runtime.status' }),
      { code: 'service_unavailable' });
    assert.equal(typeof Object.getOwnPropertyDescriptor(runtime, 'aiSdk')?.get, 'function');
    assert.equal(requests, 0);
    await runtime.dispose();
    assert.throws(() => runtime.aiSdk, { kind: 'cancelled', code: 'legacy_runtime_closed' });
  } finally { await runtime.dispose(); }
});

test('原 AI 与性能名称只转调实际独立插件，停用撤别名且不回落旧模型', async () => {
  const requests: string[] = [];
  const runtime = createFrontendRuntime({ baseUrl, workspaceStorage: null, panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname; requests.push(path);
      assert.equal(path, '/api/v2/jobs'); assert.equal(init?.method, 'POST');
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(body && typeof body === 'object' && 'operation' in body && typeof body.operation === 'string');
      return success({ ...job('alias-job'), operation: body.operation, status: 'succeeded', result: {
        metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib'], fps: false, source: 'plugin.synthetic', scope: 'main_process',
        max_samples: 3600, sample_timeout_ms: 10000,
      } }, 'actual-capabilities-log', 202);
    } });
  const ai = createAiPlugin({ id: 'deviceforge_ai', version: '1', apiVersion: 2 });
  const performance = createPerformancePlugin({ id: 'deviceforge_performance', version: '1', apiVersion: 2 });
  const aiRef = { id: 'host.ai-sdk.stream', version: '1' }, performanceRef = { id: 'host.performance', version: '1' };
  try {
    for (const plugin of [ai, performance]) {
      runtime.webPlugins.register({ id: plugin.id, trusted: true, plugin });
      await runtime.webPlugins.load(plugin.id);
    }
    await until(() => has(runtime.host, aiRef) && has(runtime.host, performanceRef));
    assert.deepEqual(requests, []);
    const observed = await call(runtime.host, aiRef, { action: 'snapshot' });
    const direct = await call(runtime.host, { id: 'deviceforge_ai.sdk.stream', version: '1' }, { action: 'snapshot' });
    assert.deepEqual(observed, direct);
    assert.deepEqual(requests, []);
    const capabilities = await call(runtime.host, performanceRef, { action: 'capabilities' });
    assert.equal(capabilities.logId, 'actual-capabilities-log');
    assert.deepEqual(requests, ['/api/v2/jobs']);
    for (const plugin of [ai, performance]) await runtime.webPlugins.unload(plugin.id);
    await until(() => !has(runtime.host, aiRef) && !has(runtime.host, performanceRef));
    await assert.rejects(async () => call(runtime.host, performanceRef, { action: 'capabilities' }), { code: 'service_unavailable' });
    assert.deepEqual(requests, ['/api/v2/jobs'], '停用不能构造旧模型或自动重放原请求');
  } finally { await runtime.dispose(); }
});

test('兼容转调继承当前服务调用链，递归被原管线拒绝而不是重置预算', async () => {
  const runtime = createFrontendRuntime({ baseUrl, workspaceStorage: null, panelTarget: () => null,
    transport: async () => { throw new Error('禁止联网'); } });
  const old = { id: 'host.alias_test', version: '1' }, target = { id: 'alias_test.api', version: '1' };
  let calls = 0;
  try {
    registerLegacyServiceAliases(runtime.host, runtime.webPlugins.extensions, [{ from: old, to: target }]);
    runtime.webPlugins.register({ id: 'alias_test', trusted: true, plugin: {
      id: 'alias_test', version: '1', apiVersion: 2, panels: [], async activate(context) {
        context.extensions?.register?.({ services: [{ ...target, invoke(input, caller, signal) {
          calls++;
          return call(caller, old, input, signal);
        } }] });
      },
    } });
    await runtime.webPlugins.load('alias_test');
    await until(() => has(runtime.host, old));
    await assert.rejects(call(runtime.host, old, {}), { code: 'service_recursive_call' });
    assert.equal(calls, 1);
  } finally { await runtime.dispose(); }
});

test('卸载撤销旧别名在途调用，迟到结果不污染重载后的提供者', async () => {
  const late = deferred<HostResult<JsonValue>>();
  const runtime = createFrontendRuntime({ baseUrl, workspaceStorage: null, panelTarget: () => null,
    transport: async () => { throw new Error('禁止联网'); } });
  const old = { id: 'host.late_alias', version: '1' }, target = { id: 'late_alias.api', version: '1' };
  let generation = 0, calls = 0;
  try {
    registerLegacyServiceAliases(runtime.host, runtime.webPlugins.extensions, [{ from: old, to: target }]);
    runtime.webPlugins.register({ id: 'late_alias', trusted: true, plugin: {
      id: 'late_alias', version: '1', apiVersion: 2, panels: [], async activate(context) {
        const current = ++generation;
        context.extensions?.register?.({ services: [{ ...target, async invoke() {
          calls++; return current === 1 ? late.promise : { data: { generation: current }, logId: 'new-log' };
        } }] });
      },
    } });
    await runtime.webPlugins.load('late_alias');
    await until(() => has(runtime.host, old));
    const pending = call(runtime.host, old, {}), rejected = assert.rejects(pending);
    await until(() => calls === 1);
    await runtime.webPlugins.unload('late_alias'); await rejected;
    await until(() => !has(runtime.host, old));
    await runtime.webPlugins.load('late_alias');
    await until(() => has(runtime.host, old));
    assert.deepEqual(await call(runtime.host, old, {}), { data: { generation: 2 }, logId: 'new-log' });
    late.resolve({ data: { generation: 1 }, logId: 'late-log' }); await turn();
    assert.equal(calls, 2, '旧等待结束和重载均不能自动重发业务');
  } finally { late.resolve({ data: null, logId: null }); await runtime.dispose(); }
});
