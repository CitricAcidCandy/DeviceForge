import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import type { Dispose, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { deferred } from './fixtures.ts';

const ref = { id: 'host.ui-directory', version: '1' };
function object(value: JsonValue | undefined) {
  assert.ok(value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}
async function snapshot(context: HostContext) {
  assert.ok(context.services);
  return object((await context.services.call(ref, { action: 'snapshot' }, context.signal)).data);
}

test('界面目录不联网，未知槽位不冒充空的已确认目录，只允许读取', async () => {
  let calls = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null,
    panelTarget: () => null, transport: async () => { calls++; throw new Error('不得联网'); } });
  try {
    const value = await snapshot(runtime.host);
    assert.equal(object(value.slots).known, false);
    assert.equal(object(value.ui).known, true);
    assert.equal(object(value.points).known, true);
    await assert.rejects(async () => runtime.host.services?.call(ref, { action: 'write', data: {} }, runtime.host.signal));
    assert.equal(calls, 0);
  } finally { await runtime.dispose(); }
});

test('槽位目录从真实晚注册生成，准备、撤销和同名新代均可发现且不暴露 DOM', async () => {
  const browser = new JSDOM('<!doctype html><html><body></body></html>');
  const target = browser.window.document.createElement('div');
  const adapter = await createNamedSlotAdapter([]);
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null,
    panelTarget: () => null, slotAdapter: adapter, slotDirectory: adapter,
    transport: async () => { throw new Error('不得联网'); } });
  const rendering = deferred<Dispose>();
  let events = 0;
  const releaseListener = runtime.host.extensions?.subscribeEvent('host.ui-directory.changed', () => events++);
  try {
    const pending = adapter.define({ id: 'example.dynamic', target, modes: ['append'], renderDefault: async () => rendering.promise });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(adapter.catalog(), [{ id: 'example.dynamic', modes: ['append'], ready: false }]);
    rendering.resolve(() => {});
    const release = await pending;
    assert.equal(adapter.catalog(), adapter.catalog(), '未变化时目录引用必须稳定');
    const value = object((await snapshot(runtime.host)).slots);
    assert.equal(value.known, true);
    assert.deepEqual(value.entries, [{ id: 'example.dynamic', modes: ['append'], ready: true }]);
    assert.doesNotMatch(JSON.stringify(value), /target|ownerDocument|renderDefault/);
    assert.ok(events >= 2);
    await release();
    assert.deepEqual(adapter.catalog(), []);
    const next = await adapter.define({ id: 'example.dynamic', target, modes: ['replace'] });
    await release();
    assert.deepEqual(adapter.catalog(), [{ id: 'example.dynamic', modes: ['replace'], ready: true }]);
    await next();
    await adapter.dispose();
    assert.deepEqual(object((await snapshot(runtime.host)).slots).entries, []);
  } finally { rendering.resolve(() => {}); await releaseListener?.(); await runtime.dispose(); await adapter.dispose(); browser.window.close(); }
});

test('统一界面快照只投影公开身份，卸载撤目录，不包含目标、布局、贡献数据或函数', async () => {
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null,
    panelTarget: () => null, transport: async () => { throw new Error('不得联网'); } });
  try {
    runtime.webPlugins.register({ id: 'directory_example', trusted: true, plugin: {
      id: 'directory_example', version: '1', apiVersion: 2, panels: [], async activate(context) {
        assert.ok(context.ui && context.extensions?.points);
        context.ui.register({ workspaces: [{ id: 'directory_example.work', title: '示例工作区' }],
          views: [{ id: 'directory_example.view', title: '示例功能', mount: async () => () => {} }] });
        context.ui.open({ instanceId: 'directory_example.one', workspaceId: 'directory_example.work',
          provider: { pluginId: 'directory_example', viewId: 'directory_example.view' }, target: { secret: 'private-target-value' } });
        context.extensions.points.define({ id: 'directory_example.point', version: '1', title: '自定义区域' });
        context.extensions.points.contribute({ id: 'directory_example.item', point: { id: 'directory_example.point', version: '1' },
          data: { secret: 'private-contribution-value' }, payload: { render() {} } });
      },
    } });
    await runtime.webPlugins.load('directory_example');
    const value = await snapshot(runtime.host);
    assert.doesNotMatch(JSON.stringify(value), /private-target-value|private-contribution-value|payload|layouts|"mount"/);
    const ui = object(value.ui), points = object(value.points);
    assert.ok(Array.isArray(ui.instances));
    assert.equal(object(ui.instances[0]).instanceId, 'directory_example.one');
    assert.ok(Array.isArray(points.contributions));
    assert.equal(object(points.contributions[0]).state, 'active');
    await runtime.webPlugins.unload('directory_example');
    const after = await snapshot(runtime.host);
    assert.deepEqual(object(object(after.ui).catalog).views, []);
    assert.deepEqual(object(after.points).contributions, []);
    await runtime.dispose();
    await assert.rejects(async () => snapshot(runtime.host));
  } finally { await runtime.dispose(); }
});
