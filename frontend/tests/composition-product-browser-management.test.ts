import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { success, requestUrl } from './fixtures.ts';
import { bundledBrowserManagement } from '../src/app/composition/bundled-browser-management.ts';
import type { JsonValue, WebPlugin } from '../src/plugin-sdk/index.ts';

const parser = registerCompositionStartupImports();
after(parser.dispose);
const { createProductServices } = await import('../src/app/product/services.ts');
const reference = { id: 'host.browser-plugins', version: '1' };
const baseUrl = 'http://127.0.0.1:7031';
function object(value: JsonValue | undefined) {
  assert.ok(value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}

test('真实产品自动提供同一公开浏览器管理服务，登记和目录快照不联网', async () => {
  const requests: string[] = [];
  const product = createProductServices({
    baseUrl, workspaceStorage: null, panelTarget: () => null,
    transport: async (input) => { requests.push(requestUrl(input).pathname); throw new Error('禁止隐式请求'); },
  });
  try {
    const services = product.runtime.host.services;
    assert.ok(services);
    assert.equal(services.catalog().filter((entry) => entry.service.id === reference.id).length, 1);
    const snapshot = object((await services.call(reference, { action: 'snapshot' }, product.runtime.host.signal)).data);
    assert.equal(object(snapshot.packages).known, false);
    assert.deepEqual(snapshot.bundled, []);
    await assert.rejects(services.call(reference, { action: 'setEnabled', source: 'bundled', id: 'missing', enabled: true },
      product.runtime.host.signal), { code: 'bundled_browser_unavailable' });
    assert.deepEqual(requests, []);
  } finally { await product.dispose(); }
});

test('公开服务启停随附页面沿用实际目录、偏好和管理器，不创建第二个实例', async () => {
  const values = new Map<string, string>(), requests: string[] = [];
  const plugin: WebPlugin = { id: 'management_example', version: '0.1.0', apiVersion: 2, panels: [],
    async activate(context) {
      context.ui?.register({ pages: [{ id: 'management_example.page', route: '/management-example',
        title: '公开管理示例', mount: async () => () => {} }] });
    },
  };
  const product = createProductServices({
    baseUrl, workspaceStorage: null, panelTarget: () => null,
    officialPlugins: { sources: [{ id: plugin.id, version: plugin.version, title: '公开管理示例', loader: async () => plugin }],
      persistence: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } } },
    transport: async (input) => {
      const path = requestUrl(input).pathname; requests.push(path);
      if (['/api/v2/plugin-packages/browser', '/api/v2/plugin-installations'].includes(path)) return success([]);
      throw new Error('只允许安装目录核对');
    },
  });
  let changes = 0;
  try {
    const host = product.runtime.host, services = host.services;
    assert.ok(services && host.ui && host.extensions);
    const release = host.extensions.subscribeEvent('host.browser-plugins.changed', () => changes++);
    const initial = object((await services.call(reference, { action: 'snapshot' }, host.signal)).data);
    assert.ok(Array.isArray(initial.bundled));
    assert.equal(object(initial.bundled[0]).phase, 'idle');
    assert.deepEqual(requests, []);
    await services.call(reference, { action: 'setEnabled', source: 'bundled', id: plugin.id, enabled: true }, host.signal);
    assert.equal(product.runtime.webPlugins.diagnosticSnapshot().filter((entry) => entry.id === plugin.id).length, 1);
    assert.equal(host.ui.catalog().pages.filter((entry) => entry.route === '/management-example').length, 1);
    await services.call(reference, { action: 'setEnabled', source: 'bundled', id: plugin.id, enabled: false }, host.signal);
    assert.equal(host.ui.catalog().pages.some((entry) => entry.route === '/management-example'), false);
    assert.equal(product.officialPlugins?.snapshot()[0]?.phase, 'disabled');
    assert.equal(values.get(`deviceforge.official:${baseUrl}:${plugin.id}`), 'disabled');
    assert.ok(changes > 0);
    assert.deepEqual(requests.sort(), ['/api/v2/plugin-installations', '/api/v2/plugin-packages/browser']);
    await release();
    await product.dispose();
    await assert.rejects(async () => services.call(reference, { action: 'snapshot' }, new AbortController().signal));
  } finally { await product.dispose(); }
});

test('随附适配保留调试器真实来源，重复身份拒绝操作，订阅可幂等撤销', async () => {
  let calls = 0, released = 0;
  const sameId = 'deviceforge_debugger';
  const adapter = bundledBrowserManagement({
    official: {
      snapshot: () => [{ id: sameId, title: '另一来源', version: '0.1.0', phase: 'disabled', error: null }],
      subscribe: () => () => { released++; }, setEnabled: async () => { calls++; },
    },
    debugger: {
      identity: { id: sameId, version: '0.1.0' }, snapshot: () => ({ phase: 'unavailable', message: '仅本机可用' }),
      subscribe: () => () => { released++; }, setEnabled: async () => { calls++; },
    },
  });
  assert.equal(adapter.snapshot()[1]?.phase, 'unavailable');
  assert.equal(adapter.snapshot()[1]?.error, '仅本机可用');
  await assert.rejects(adapter.setEnabled(sameId, true, new AbortController().signal), { code: 'ambiguous_bundled_source' });
  assert.equal(calls, 0);
  const release = adapter.subscribe(() => {});
  await release(); await release();
  assert.equal(released, 2);
});
