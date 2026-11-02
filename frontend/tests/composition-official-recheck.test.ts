import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createOfficialPlugins } from '../src/app/composition/official-plugins.ts';
import type { OfficialPluginSource } from '../src/app/composition/manifest-sources.ts';
import type { WebPlugin } from '../src/plugin-sdk/index.ts';
import { deferred, installedPackage, requestUrl, success } from './fixtures.ts';

const packagesPath = '/api/v2/plugin-packages/browser';
const installationsPath = '/api/v2/plugin-installations';
const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

async function fixture(refreshPath: string) {
  const entered = deferred<void>(), activation = deferred<void>(), response = deferred<Response>();
  let refreshing = false, activations = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      if (path !== packagesPath && path !== installationsPath) throw new Error('只允许安装目录读取');
      return refreshing && path === refreshPath ? response.promise : success([]);
    },
  });
  const plugin: WebPlugin = {
    id: 'example', version: '1.0.0', apiVersion: 2, panels: [],
    async activate() {
      activations++;
      entered.resolve();
      await activation.promise;
    },
  };
  const source: OfficialPluginSource = {
    id: plugin.id, version: plugin.version, title: '随附示例', loader: async () => plugin,
  };
  const official = createOfficialPlugins({
    runtime, sources: [source], baseUrl: 'http://127.0.0.1:7031',
  });
  const caller = new AbortController();
  const result: { state: string; error: unknown } = { state: 'pending', error: null };
  const operation = official.setEnabled(plugin.id, true, caller.signal).then(
    () => { result.state = 'loaded'; },
    (error: unknown) => { result.state = 'failed'; result.error = error; },
  );
  await entered.promise;
  refreshing = true;
  const reading = refreshPath === packagesPath
    ? runtime.pluginPackages.refresh('browser', runtime.host.signal)
    : runtime.pluginInstallations.refresh(runtime.host.signal);
  return {
    runtime, official, caller, operation, result, activation, response, reading,
    activations: () => activations,
    async dispose() {
      activation.resolve();
      response.resolve(success([]));
      await Promise.allSettled([operation, reading]);
      official.dispose();
      await runtime.dispose();
    },
  };
}

for (const path of [packagesPath, installationsPath]) {
  test(`插件激活中 ${path} 再次刷新，等待原读取而不把暂时未知记成加载失败`, { timeout: 3000 }, async () => {
    const f = await fixture(path);
    try {
      f.activation.resolve();
      await turn();
      assert.equal(f.result.state, 'pending', '目录重读未结束，不能把已加载的插件误报失败');
      f.response.resolve(success([]));
      await f.reading;
      await f.operation;
      assert.equal(f.result.state, 'loaded');
      assert.equal(f.official.snapshot()[0]?.phase, 'loaded');
      assert.equal(f.activations(), 1, '重新确认只读目录，不重放激活');
    } finally { await f.dispose(); }
  });
}

test('激活后的目录确认可取消，不撤销其他调用拥有的目录读取', { timeout: 3000 }, async () => {
  const f = await fixture(packagesPath);
  try {
    f.activation.resolve();
    await turn();
    assert.equal(f.result.state, 'pending');
    f.caller.abort();
    await f.operation;
    assert.equal(f.result.state, 'failed');
    assert.match(f.result.error instanceof Error ? f.result.error.message : '', /取消|撤销/);
    assert.equal(f.runtime.pluginPackages.snapshot('browser').pending, true);
    f.response.resolve(success([]));
    await f.reading;
    assert.equal(f.runtime.pluginPackages.snapshot('browser').error, null);
    assert.equal(f.activations(), 1);
  } finally { await f.dispose(); }
});

test('激活后的重读发现同身份独立安装，仍以独立安装为准', { timeout: 3000 }, async () => {
  const f = await fixture(packagesPath);
  try {
    f.activation.resolve();
    await turn();
    assert.equal(f.result.state, 'pending');
    f.response.resolve(success([installedPackage('browser', { id: 'example' })]));
    await f.reading;
    await f.operation;
    assert.equal(f.result.state, 'failed');
    assert.match(f.result.error instanceof Error ? f.result.error.message : '', /独立安装/);
    assert.equal(f.official.snapshot()[0]?.phase, 'external');
    assert.equal(f.activations(), 1);
  } finally { await f.dispose(); }
});
