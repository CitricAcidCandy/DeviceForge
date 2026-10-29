import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import type { WebPlugin } from '../src/plugin-sdk/index.ts';
import { dom } from './dom-fixtures.ts';

test('独立页面经真实runtime公开挂载，loaded通知可重读且旧释放不拆新代', async () => {
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { throw new Error('页面登记与渲染不应自动请求业务数据'); },
  });
  const ui = runtime.host.ui;
  const events = runtime.host.extensions;
  assert.ok(ui?.mount && events);
  const observed: string[] = [];
  const loadedStates: string[] = [];
  events.subscribeEvent('host.plugins.changed', ({ data }) => {
    if (data && typeof data === 'object' && !Array.isArray(data) &&
        data.pluginId === 'page_owner' && typeof data.stage === 'string') {
      observed.push(data.stage);
      if (data.stage === 'loaded') {
        loadedStates.push(runtime.webPlugins.diagnosticSnapshot().find((item) => item.id === 'page_owner')?.state ?? 'missing');
      }
    }
  });
  const plugin: WebPlugin = {
    id: 'page_owner', version: '1.0.0', apiVersion: 2, panels: [],
    activate: async (context) => {
      context.ui?.register({ pages: [{
        id: 'page_owner.page', title: '独立页面', route: '/custom/page',
        mount: async (target) => {
          target.textContent = '页面内容';
          return () => { target.textContent = ''; };
        },
      }] });
    },
  };
  runtime.bundledPlugins.register({ id: plugin.id, trusted: true, loader: async () => plugin });
  const target = dom();
  try {
    await runtime.webPlugins.load(plugin.id);
    ui.open({ instanceId: 'host.page_instance', workspaceId: 'page_owner.page',
      provider: { pluginId: plugin.id, viewId: 'page_owner.page' } });
    const releaseOld = await ui.mount('host.page_instance', target, runtime.host.signal);
    assert.equal(target.textContent, '页面内容');
    await runtime.webPlugins.unload(plugin.id);
    assert.equal(target.textContent, '');
    await runtime.webPlugins.load(plugin.id);
    const releaseNew = await ui.mount('host.page_instance', target, runtime.host.signal);
    await releaseOld();
    assert.equal(target.textContent, '页面内容');
    assert.equal(observed.filter((stage) => stage === 'loaded').length, 2);
    assert.deepEqual(loadedStates, ['loaded', 'loaded']);
    assert.ok(observed.includes('unloaded'));
    await releaseNew();
  } finally { await runtime.dispose(); }
});
