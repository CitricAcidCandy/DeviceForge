import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginManager } from '../src/plugins/manager.ts';
import type { PluginLifecycleObservation } from '../src/plugins/manager.ts';
import type { HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import { children, dom } from './dom-fixtures.ts';

function host(): HostContext {
  return {
    apiVersion: 2, signal: new AbortController().signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('不调用业务'); },
    getJob: async () => { throw new Error('不查询业务'); },
    cancelJob: async () => { throw new Error('不取消业务'); },
    subscribeOperations: () => () => {}, onDispose: () => () => {},
  };
}
function plugin(): WebPlugin {
  return { id: 'example', version: '1.0.0', apiVersion: 2,
    panels: [{ id: 'example.panel', title: '主面板', mount: async () => () => {} }] };
}

test('调试底座和观测回调异常不能阻塞插件装卸', async () => {
  const manager = createPluginManager({ host: host(), panelTarget: () => null,
    debugForPlugin: () => { throw new Error('观测底座失效'); },
    observe: () => { throw new Error('调试记录失效'); },
  });
  manager.register({ id: 'example', trusted: true, plugin: plugin() });
  await manager.load('example');
  assert.equal(manager.snapshot()[0]?.state, 'loaded');
  await manager.unload('example');
  assert.deepEqual(manager.snapshot(), []);
  await manager.dispose();
});

test('面板根携带真实所有权，换代与生命周期观测保持一致', async () => {
  const target = dom();
  const events: PluginLifecycleObservation[] = [];
  const manager = createPluginManager({ host: host(), panelTarget: () => target,
    observe: (event) => { events.push(event); },
  });
  manager.register({ id: 'example', trusted: true, plugin: plugin() });
  const first = await manager.load('example');
  await manager.mount('example', 'example.panel');
  assert.equal(children(target)[0]?.dataset.deviceforgePlugin, 'example');
  assert.equal(children(target)[0]?.dataset.deviceforgeGeneration, String(first.generation));
  await manager.unload('example');
  assert.equal(children(target).length, 0);
  const next = await manager.load('example');
  assert.notEqual(next.generation, first.generation);
  assert.deepEqual(events.slice(0, 4).map((event) => event.stage), ['loading', 'loaded', 'unloading', 'unloaded']);
  assert.ok(events.every((event) => event.pluginId === 'example' && Number.isFinite(event.at)));
  await manager.dispose();
});
