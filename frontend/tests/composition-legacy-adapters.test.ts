import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createLegacyCompositionAdapter } from '../src/app/composition/legacy-adapters.ts';

test('独立兼容适配器只登记旧设置扩展桥，不装配或恢复任何宿主业务页面', async () => {
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async () => { throw new Error('旧贡献兼容登记不得发起业务请求'); },
  });
  try {
    const adapter = createLegacyCompositionAdapter(runtime.extensions);
    runtime.bundledPlugins.register({ id: adapter.id, trusted: true, plugin: adapter });
    await runtime.webPlugins.load(adapter.id);
    assert.deepEqual(runtime.host.ui?.catalog().pages, []);
    assert.deepEqual(runtime.host.ui?.catalog().workspaces, []);
    assert.deepEqual(runtime.host.ui?.catalog().views.map((view) => view.id), [
      'host_legacy_adapters.settings-section',
    ]);
    await runtime.webPlugins.unload(adapter.id);
    assert.deepEqual(runtime.host.ui?.catalog().views, []);
    assert.deepEqual(runtime.host.ui?.catalog().pages, []);
    await runtime.webPlugins.load(adapter.id);
    assert.deepEqual(runtime.host.ui?.catalog().pages, []);
    assert.equal(runtime.host.ui?.catalog().views.length, 1);
  } finally { await runtime.dispose(); }
});
