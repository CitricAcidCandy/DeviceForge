import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { createPluginDefaults } from '../src/features/plugin-defaults/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import { deferred, installedPackage, signal } from './fixtures.ts';

const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });
function fixture() {
  const entered = deferred<void>(), completion = deferred<void>();
  let activations = 0, packageEnables = 0, originalSignal: AbortSignal | null = null;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    workspaceStorage: null, transport: async () => { throw new Error('等待既有加载不应访问服务器'); },
  });
  runtime.webPlugins.register({ id: 'existing-browser', trusted: true, plugin: {
    id: 'existing-browser', version: '1.0.0', apiVersion: 2, panels: [],
    async activate(context: HostContext) {
      activations++; originalSignal = context.signal; entered.resolve(); await completion.promise;
    },
  } });
  const feature = createPluginDefaults({ browserPlugins: runtime.webPlugins, packages: {
    refresh: async (kind) => ({ data: kind === 'browser'
      ? [installedPackage('browser', { id: 'existing-browser' })] : [], logId: `${kind}-directory-log` }),
    enable: async () => { packageEnables++; throw new Error('不能重复发起正在进行的插件激活'); },
  }, serverPlugins: { refresh: async () => ({ data: [], logId: 'server-runtime-log' }) } });
  const loading = runtime.webPlugins.load('existing-browser');
  void loading.catch(() => undefined);
  return { runtime, feature, entered, completion, loading,
    counts: () => ({ activations, packageEnables, originalAborted: originalSignal?.aborted }),
    async dispose() {
      completion.resolve(); await loading.catch(() => undefined); feature.dispose(); await runtime.dispose();
    },
  };
}

test('默认启用等待真实管理器的同代既有加载，不提前报失败或再次激活', async () => {
  const f = fixture();
  let completed = false;
  await f.entered.promise;
  const waiting = f.feature.start(signal());
  void waiting.then(() => { completed = true; }, () => { completed = true; });
  try {
    await turn();
    assert.equal(completed, false, '同代加载尚未确认时，默认启用保持等待');
    assert.equal(f.feature.snapshot().results.some((value) => value.id === 'existing-browser'), false);
    f.completion.resolve(); await f.loading;
    const result = await waiting;
    assert.equal(result.results.find((value) => value.id === 'existing-browser')?.status, 'already_enabled');
    assert.deepEqual(f.counts(), { activations: 1, packageEnables: 0, originalAborted: false });
  } finally { await f.dispose(); await waiting.catch(() => undefined); }
});

test('既有激活真实失败时交付原错误和日志，不把loading当失败也不自动重试', async () => {
  const f = fixture();
  await f.entered.promise;
  const waiting = f.feature.start(signal());
  const failure = new ApiError('http', 'existing_activation_failed', '原插件激活失败', 503, 'existing-activation-log');
  try {
    await turn();
    f.completion.reject(failure);
    await assert.rejects(f.loading, (reason: unknown) => reason === failure);
    const result = await waiting;
    assert.equal(result.results.find((value) => value.id === 'existing-browser')?.message, failure.message);
    assert.equal(result.results.find((value) => value.id === 'existing-browser')?.logId, failure.logId);
    assert.equal(f.counts().activations, 1);
    assert.equal(f.counts().packageEnables, 0);
  } finally { await f.dispose(); await waiting.catch(() => undefined); }
});

test('取消默认启用只结束本次等待，原插件加载可独立成功且晚到不改写取消状态', async () => {
  const f = fixture();
  const controller = new AbortController();
  await f.entered.promise;
  const waiting = f.feature.start(controller.signal);
  void waiting.catch(() => undefined);
  try {
    await turn(); controller.abort();
    await assert.rejects(waiting, (reason: unknown) => reason instanceof ApiError && reason.kind === 'cancelled');
    const cancelled = f.feature.snapshot();
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(f.counts().originalAborted, false);
    f.completion.resolve(); await f.loading; await turn();
    assert.equal(f.runtime.webPlugins.snapshot().find((value) => value.id === 'existing-browser')?.state, 'loaded');
    assert.equal(f.feature.snapshot(), cancelled);
    assert.equal(f.counts().activations, 1);
    assert.equal(f.counts().packageEnables, 0);
  } finally { await f.dispose(); await waiting.catch(() => undefined); }
});
