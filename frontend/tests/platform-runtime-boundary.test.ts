import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import type { Dispose, HostContext } from '../src/plugin-sdk/index.ts';
import type { PlatformRuntime } from '../src/app/platform-runtime.ts';

const parser = registerCompositionStartupImports();
after(parser.dispose);
const { createPlatformRuntime } = await import('../src/app/platform-runtime.ts');
const { createFrontendRuntime } = await import('../src/app/runtime.ts');
const { createLegacyRuntimeAdapter } = await import('../src/app/composition/legacy-runtime.ts');
const baseUrl = 'http://127.0.0.1:7031';
function options() {
  let requests = 0;
  return {
    value: { baseUrl, workspaceStorage: null, panelTarget: () => null,
      transport: async () => { requests++; throw new Error('运行时边界单元禁止业务和联网'); } },
    get requests() { return requests; },
  };
}
function available(context: HostContext, id: string) {
  return context.services?.catalog().some((entry) =>
    entry.available && entry.service.id === id && entry.service.version === '1') ?? false;
}
function trackedHost(core: PlatformRuntime) {
  const callbacks = new Set<Dispose>();
  const tracked: PlatformRuntime = {
    ...core,
    host: {
      ...core.host,
      onDispose(callback) {
        callbacks.add(callback);
        return core.host.onDispose(() => {
          callbacks.delete(callback);
          return callback();
        });
      },
    },
  };
  return { core: tracked, callbacks };
}

test('纯平台运行时没有旧业务getter，仍使用原管理器和公开平台能力且默认不联网', async () => {
  const f = options(), core = createPlatformRuntime(f.value);
  try {
    for (const name of ['aiSdk', 'aiSdkStreaming', 'performance'])
      assert.equal(name in core, false, `纯平台运行时不能公开旧业务访问器：${name}`);
    assert.ok(core.host.ui && core.host.data && core.host.services && core.host.transport);
    assert.ok(core.webPlugins && core.requestClient && core.mirroringStreaming);
    assert.equal(available(core.host, 'host.ai-sdk'), false);
    core.webPlugins.register({ id: 'platform_boundary_probe', trusted: true, plugin: {
      id: 'platform_boundary_probe', version: '1', apiVersion: 2, panels: [],
      async activate(context) {
        context.ui?.register({ workspaces: [{ id: 'platform_boundary_probe.work', title: '独立工作区' }],
          pages: [{ id: 'platform_boundary_probe.page', title: '独立页面',
            route: '/platform-boundary', workspaceId: 'platform_boundary_probe.work' }] });
      },
    } });
    await core.webPlugins.load('platform_boundary_probe');
    assert.equal(core.host.ui.catalog().pages[0]?.pluginId, 'platform_boundary_probe');
    assert.equal(f.requests, 0);
  } finally { await core.dispose(); }
});

test('旧wrapper保留惰性getter与默认薄别名语义，关闭后不补建旧模型', async () => {
  const f = options(), runtime = createFrontendRuntime(f.value);
  try {
    assert.equal(typeof Object.getOwnPropertyDescriptor(runtime, 'aiSdk')?.get, 'function');
    assert.equal(runtime.aiSdk, runtime.aiSdk);
    assert.equal(available(runtime.host, 'host.ai-sdk'), false);
    assert.equal(available(runtime.host, 'host.performance'), false);
    assert.equal(f.requests, 0);
    const first = runtime.dispose();
    assert.equal(runtime.dispose(), first);
    await first;
    assert.throws(() => runtime.performance, { code: 'legacy_runtime_closed' });
    assert.throws(() => runtime.aiSdkStreaming, { code: 'legacy_runtime_closed' });
    assert.equal(f.requests, 0);
  } finally { await runtime.dispose(); }
});

test('旧wrapper显式旧服务开关使用真实旧模型，关闭撤资格且没有别名冲突', async () => {
  const f = options(), runtime = createFrontendRuntime({ ...f.value, legacyBusinessServices: true });
  try {
    for (const id of ['host.ai-sdk', 'host.ai-sdk.stream', 'host.performance'])
      assert.equal(available(runtime.host, id), true);
    const services = runtime.host.services;
    assert.ok(services);
    assert.equal(services.diagnostics().some((feature) => feature.featureId.startsWith('legacy-alias.')), false);
    const result = await services.call({ id: 'host.ai-sdk.stream', version: '1' },
      { action: 'snapshot' }, runtime.host.signal);
    assert.equal(result.logId, null);
    assert.ok(result.data && typeof result.data === 'object' && !Array.isArray(result.data));
    assert.deepEqual(result.data.session, runtime.aiSdkStreaming.snapshot().session);
    assert.equal(f.requests, 0);
  } finally { await runtime.dispose(); }
});

test('显式适配器复用同一内核，手动关闭撤销自有旧服务和兜底回调，重复挂接不积累', async () => {
  const f = options(), core = createPlatformRuntime({ ...f.value, legacyServiceAliases: false });
  const tracked = trackedHost(core);
  try {
    for (let index = 0; index < 2; index++) {
      const adapter = createLegacyRuntimeAdapter(tracked.core, { registerServices: true });
      assert.equal(adapter.runtime.webPlugins, core.webPlugins);
      assert.equal(adapter.runtime.requestClient, core.requestClient);
      assert.equal(adapter.runtime.host, tracked.core.host);
      assert.equal(tracked.callbacks.size, 1, '每个适配器只登记一个兜底回调');
      assert.equal(available(core.host, 'host.ai-sdk.stream'), true);
      let releases = 0;
      const ai = adapter.runtime.aiSdk, closeAi = ai.dispose;
      ai.dispose = () => { releases++; closeAi(); };
      const first = adapter.dispose();
      assert.equal(adapter.dispose(), first);
      assert.equal(core.host.signal.aborted, false, '关闭适配器不关闭平台');
      await first;
      assert.equal(releases, 1);
      assert.equal(tracked.callbacks.size, 0, '手动关闭必须撤销根兜底登记');
      for (const id of ['host.ai-sdk', 'host.ai-sdk.stream', 'host.performance'])
        assert.equal(available(core.host, id), false);
      assert.equal(f.requests, 0);
    }
    core.webPlugins.register({ id: 'after_legacy', trusted: true, plugin: {
      id: 'after_legacy', version: '1', apiVersion: 2, panels: [],
    } });
    await core.webPlugins.load('after_legacy');
    assert.equal(core.webPlugins.snapshot().find((entry) => entry.id === 'after_legacy')?.state, 'loaded');
  } finally { await core.dispose(); }
});

test('平台直接关闭兜底释放已创建旧模型，未创建getter在关闭后不能补建', async () => {
  const f = options(), core = createPlatformRuntime({ ...f.value, legacyServiceAliases: false });
  const tracked = trackedHost(core), adapter = createLegacyRuntimeAdapter(tracked.core);
  const ai = adapter.runtime.aiSdk, closeAi = ai.dispose;
  let releases = 0;
  ai.dispose = () => { releases++; closeAi(); };
  try {
    await core.dispose();
    assert.equal(releases, 1);
    assert.equal(tracked.callbacks.size, 0);
    assert.throws(() => adapter.runtime.performance, { code: 'legacy_runtime_closed' });
    assert.throws(() => adapter.runtime.aiSdkStreaming, { code: 'legacy_runtime_closed' });
    await adapter.dispose();
    assert.equal(releases, 1);
    assert.equal(f.requests, 0);
  } finally { await core.dispose(); }
});

test('wrapper同步先发起旧模型释放再关闭内核，两方失败均保留且全局关闭幂等', async () => {
  const f = options(), runtime = createFrontendRuntime(f.value);
  const legacyError = new Error('本次旧模型释放失败'), kernelError = new Error('本次内核插件释放失败');
  const order: string[] = [];
  const ai = runtime.aiSdk, closeAi = ai.dispose;
  ai.dispose = () => { order.push('legacy'); closeAi(); throw legacyError; };
  runtime.webPlugins.register({ id: 'closing_failure', trusted: true, plugin: {
    id: 'closing_failure', version: '1', apiVersion: 2, panels: [],
    async activate(context) {
      context.onDispose(() => { order.push('kernel'); throw kernelError; });
    },
  } });
  await runtime.webPlugins.load('closing_failure');
  const first = runtime.dispose();
  assert.equal(order[0], 'legacy');
  assert.equal(runtime.host.signal.aborted, true);
  assert.equal(runtime.dispose(), first);
  function includes(error: unknown, expected: Error): boolean {
    return error === expected ||
      (error instanceof AggregateError && error.errors.some((item: unknown) => includes(item, expected)));
  }
  await assert.rejects(first, (error: unknown) =>
    includes(error, legacyError) && includes(error, kernelError));
  assert.equal(order.filter((item) => item === 'legacy').length, 1);
  assert.equal(order.filter((item) => item === 'kernel').length, 1);
  assert.equal(f.requests, 0);
});

test('旧服务真实登记拒绝活动别名配置，已关闭平台也不能新挂适配器', async () => {
  const f = options(), core = createPlatformRuntime(f.value);
  try {
    assert.throws(() => createLegacyRuntimeAdapter(core, { registerServices: true }),
      { code: 'legacy_runtime_alias_conflict' });
    assert.equal(core.host.signal.aborted, false);
    assert.equal(available(core.host, 'host.ai-sdk'), false);
    await core.dispose();
    assert.throws(() => createLegacyRuntimeAdapter(core), { code: 'legacy_runtime_closed' });
    assert.equal(f.requests, 0);
  } finally { await core.dispose(); }
});
