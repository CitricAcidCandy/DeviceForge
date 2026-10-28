import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import type { DebugAccess } from '../src/plugin-sdk/index.ts';
import { success } from './fixtures.ts';

const instanceId = '4d6fb332-4b01-4bbc-a655-a753ac092f91';
const signal = () => new AbortController().signal;
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.fail('等待本机调试装配条件超时');
}

test('宿主公开调试服务可发现且独立工厂不自动联网', async () => {
  const document = new JSDOM('<body></body>').window.document;
  let requests = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null,
    debugger: { document }, transport: async () => { requests++; throw new Error('不应联网'); } });
  try {
    let access: DebugAccess | undefined;
    runtime.webPlugins.register({ id: 'example', trusted: true, plugin: {
      id: 'example', version: '0.1.0', apiVersion: 2, panels: [], activate: async (context) => { access = context.debug; },
    } });
    await runtime.webPlugins.load('example');
    assert.ok(access);
    const result = await runtime.extensions.callService('host.debugger', '1', { action: 'capabilities' }, signal());
    assert.ok(result.data && typeof result.data === 'object' && !Array.isArray(result.data));
    assert.equal(result.data.production_acceptance_complete, false);
    assert.equal(requests, 0);
    await assert.rejects(runtime.extensions.callService('host.debugger', '1',
      { action: 'call', name: 'deviceforge.shutdown', input: {} }, signal()), /公开调试工具/);
    assert.equal(requests, 0);
  } finally { await runtime.dispose(); }
});

test('显式启动后登记当前实例，关闭释放桥且非回环宿主不开放调试服务', async () => {
  const document = new JSDOM('<body></body>').window.document;
  const paths: string[] = [];
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null,
    debugger: { document }, transport: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input)); paths.push(url.pathname);
      if (url.pathname.endsWith('/register')) return success({ instance_id: instanceId, plugins: [], active_sessions: 0, idle_ttl_ms: 60000 });
      if (url.pathname.endsWith('/heartbeat')) return success({ instance_id: instanceId, active_sessions: [], targets: [] });
      if (url.pathname.endsWith('/disconnect')) return success({ disconnected: true });
      throw new Error('没有会话，不应请求命令队列');
    } });
  await runtime.debugger?.start();
  assert.equal(runtime.debugger?.snapshot().instanceId, instanceId);
  await runtime.dispose();
  assert.ok(paths.includes('/api/v2/debugger/bridge/disconnect'));
  const remote = createFrontendRuntime({ baseUrl: 'http://192.168.1.2:7031', panelTarget: () => null,
    debugger: { document }, transport: async () => { throw new Error('不应联网'); } });
  try {
    assert.equal(remote.debugger, null);
    assert.equal(remote.extensions.catalog().services.some((service) => service.id === 'host.debugger'), false);
  } finally { await remote.dispose(); }
});

test('developer.tools在普通贡献机制挂载，业务节点变更不卸载工具', async () => {
  const document = new JSDOM('<body><main></main><aside></aside></body>').window.document;
  const target = document.querySelector('aside');
  assert.ok(target);
  const slots = await createNamedSlotAdapter([{ id: 'developer.tools', target, modes: ['append'] }]);
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null,
    developerTools: true, slotAdapter: slots, transport: async () => { throw new Error('不应联网'); } });
  let mounts = 0, releases = 0;
  try {
    runtime.webPlugins.register({ id: 'example', trusted: true, plugin: {
      id: 'example', version: '0.1', apiVersion: 2, panels: [], contributions: { components: [{
        id: 'example.tools', title: '工具', slot: 'developer.tools', mode: 'append',
        mount: async (root) => { mounts++; root.textContent = '工具'; return () => { releases++; }; },
      }] },
    } });
    await runtime.webPlugins.load('example');
    await until(() => target.textContent === '工具');
    document.querySelector('main')?.replaceChildren(document.createElement('section'));
    assert.equal(mounts, 1); assert.equal(releases, 0);
    await runtime.webPlugins.unload('example');
    assert.equal(releases, 1); assert.equal(target.textContent, '');
  } finally { await runtime.dispose(); await slots.dispose(); }
});

test('调试资源的真实释放失败保留原清理诊断，但不封锁新代插件', async () => {
  const document = new JSDOM('<body></body>').window.document;
  let releases = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null,
    debugger: { document }, transport: async () => { throw new Error('不应联网'); } });
  runtime.webPlugins.register({ id: 'example', trusted: true, plugin: {
    id: 'example', version: '0.1', apiVersion: 2, panels: [],
    activate: async (context) => {
      assert.ok(context.debug);
      context.debug.registerResource({ id: 'resource', kind: 'test', label: '受控资源' }, () => {
        if (++releases === 1) throw new Error('本次真实释放失败');
      });
    },
  } });
  try {
    const first = await runtime.webPlugins.load('example');
    await assert.rejects(runtime.webPlugins.unload('example'), /卸载未完整释放/);
    assert.equal(runtime.webPlugins.cleanupSnapshot()[0]?.generation, first.generation);
    const next = await runtime.webPlugins.load('example');
    assert.notEqual(next.generation, first.generation);
    assert.equal(runtime.webPlugins.cleanupSnapshot()[0]?.generation, first.generation);
    assert.equal(runtime.webPlugins.snapshot()[0]?.state, 'loaded');
  } finally { await runtime.dispose(); }
  assert.equal(releases, 2);
});
