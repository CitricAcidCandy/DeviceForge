import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import type { RuntimeOptions } from '../src/app/index.ts';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import type { ComponentContribution, PluginContributions, WebPlugin } from '../src/plugin-sdk/index.ts';
import { HOST_SLOTS, isKnownSlot, pageSlotId, routeSlotId, slotModes } from '../src/app/product/slots.ts';
import {
  isPluginRoute,
  parseProductRoute,
  pluginRoute,
  routeHash,
  splitPluginRoute,
} from '../src/app/product/routes.ts';
import { job, success } from './fixtures.ts';
import { children, dom } from './dom-fixtures.ts';

function runtime(overrides: Partial<RuntimeOptions> = {}) {
  return createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async () => success(job()),
    ...overrides,
  });
}
function register(
  instance: ReturnType<typeof runtime>,
  id: string,
  contributions: PluginContributions,
) {
  const plugin: WebPlugin = {
    id,
    version: '1.0',
    apiVersion: 2,
    panels: [],
    contributions,
  };
  instance.webPlugins.register({ id, trusted: true, plugin });
}
function widget(
  id: string,
  slot: string,
  mode: 'append' | 'replace',
  text: string = mode,
): ComponentContribution {
  return {
    id,
    title: `组件 ${id}`,
    slot,
    mode,
    mount: async (target) => {
      target.textContent = text;
      return () => {
        target.textContent = '';
      };
    },
  };
}

test('晚注册槽位是纯挂载点：不生成默认根，替换贡献装卸都只动插件根', async () => {
  const host = dom();
  const adapter = await createNamedSlotAdapter([]);
  const instance = runtime({ slotAdapter: adapter });
  const slots = instance.extensions.slots;
  assert.ok(slots, '晚注册适配器必须投影出 slots 入口');
  const release = await slots.define({ id: 'route.performance', target: host });
  assert.equal(host.children.length, 0, '没有默认渲染器时槽位不占用宿主 DOM');

  register(instance, 'demo', {
    components: [widget('demo.pane', 'route.performance', 'replace', '插件接管')],
  });
  await instance.webPlugins.load('demo');
  await instance.extensions.mountComponent('demo.pane');
  assert.equal(host.textContent, '插件接管');

  await instance.webPlugins.unload('demo');
  assert.equal(host.children.length, 0, '卸载后槽位回落为空，宿主内容由 React 自己渲染');
  await release();
  await instance.dispose();
  await adapter.dispose();
});

test('晚注册槽位按声明重建默认渲染，释放后不再重建', async () => {
  const host = dom();
  const adapter = await createNamedSlotAdapter([]);
  const instance = runtime({ slotAdapter: adapter });
  const slots = instance.extensions.slots;
  assert.ok(slots);
  let renders = 0;
  const release = await slots.define({
    id: 'area.demo',
    target: host,
    renderDefault: (target) => {
      target.textContent = `默认${++renders}`;
      return () => undefined;
    },
  });
  assert.equal(renders, 1, '定义即渲染默认内容');
  register(instance, 'demo', {
    components: [widget('demo.pane', 'area.demo', 'replace', '插件')],
  });
  await instance.webPlugins.load('demo');
  await instance.extensions.mountComponent('demo.pane');
  assert.equal(renders, 1, '替换期间默认渲染已让位');
  await instance.webPlugins.unload('demo');
  assert.equal(renders, 2, '插件卸载后恢复默认渲染');
  await release();
  assert.equal(renders, 2, '槽位释放后不再重建默认渲染');
  assert.equal(host.children.length, 0);
  await instance.dispose();
  await adapter.dispose();
});

test('重复登记的槽位标识被拒绝', async () => {
  const adapter = await createNamedSlotAdapter([]);
  const slots = adapter;
  const first = dom();
  const second = dom();
  const release = await slots.define({ id: 'route.devices', target: first });
  await assert.rejects(slots.define({ id: 'route.devices', target: second }), /重复/);
  await assert.rejects(slots.define({ id: 'Route.Devices', target: second }), /无效/);
  await release();
  await adapter.dispose();
});

test('受保护槽位拒绝替换渲染，追加渲染可用', async () => {
  const host = dom();
  const adapter = await createNamedSlotAdapter([
    { id: 'route.marketplace', target: host, modes: ['append'] },
  ]);
  const instance = runtime({ slotAdapter: adapter });
  register(instance, 'demo', {
    components: [
      widget('demo.replace', 'route.marketplace', 'replace'),
      widget('demo.append', 'route.marketplace', 'append', '追加'),
    ],
  });
  await instance.webPlugins.load('demo');
  await assert.rejects(instance.extensions.mountComponent('demo.replace'), /槽位不允许替换/);
  await instance.webPlugins.load('demo');
  await instance.extensions.mountComponent('demo.append');
  assert.equal(host.textContent, '追加');
  await instance.dispose();
  await adapter.dispose();
});

test('未登记的槽位在挂载时明确报错，不静默成功', async () => {
  const adapter = await createNamedSlotAdapter([]);
  const instance = runtime({ slotAdapter: adapter });
  const slots = instance.extensions.slots;
  assert.ok(slots);
  await slots.define({ id: 'route.devices', target: dom() });
  register(instance, 'demo', {
    components: [widget('demo.pane', 'route.absent', 'append')],
  });
  await instance.webPlugins.load('demo');
  await assert.rejects(instance.extensions.mountComponent('demo.pane'), /宿主未登记此具名槽位/);
  await instance.dispose();
  await adapter.dispose();
});

test('目录快照引用稳定，并在贡献变化时通知订阅者', async () => {
  const instance = runtime();
  const first = instance.extensions.catalog();
  assert.equal(instance.extensions.catalog(), first, '无变化时必须返回同一引用');
  let notified = 0;
  const unsubscribe = instance.extensions.subscribe(() => {
    notified += 1;
  });
  register(instance, 'demo', { components: [widget('demo.pane', 'route.devices', 'append')] });
  await instance.webPlugins.load('demo');
  assert.ok(notified >= 1, '登记贡献必须通知订阅者');
  const second = instance.extensions.catalog();
  assert.notEqual(second, first, '变化后必须换新快照');
  assert.equal(second.components.length, 1);
  assert.equal(instance.extensions.catalog(), second);
  await instance.webPlugins.unload('demo');
  assert.equal(instance.extensions.catalog().components.length, 0);
  unsubscribe();
  await instance.dispose();
});

test('宿主槽位清单开放全部路由，市场与设置只允许追加', () => {
  assert.equal(HOST_SLOTS.length, 13, '11 个路由槽位 + 2 个区域槽位');
  for (const route of [
    'devices',
    'files',
    'performance',
    'frida',
    'automation',
    'terminal',
    'ai',
    'analysis',
    'tasks',
    'marketplace',
    'settings',
  ] as const)
    assert.ok(isKnownSlot(routeSlotId(route)), `缺少路由槽位 ${route}`);
  assert.deepEqual([...slotModes('route.marketplace')], ['append']);
  assert.deepEqual([...slotModes('route.settings')], ['append']);
  assert.deepEqual([...slotModes('route.devices')], ['append', 'replace']);
  assert.deepEqual([...slotModes('page.demo.pane')], ['replace']);
  assert.ok(isKnownSlot('page.demo.pane'));
  assert.equal(isKnownSlot('route.unknown'), false);
  assert.equal(isKnownSlot('demo.pane'), false);
  assert.deepEqual([...slotModes('devices.apps')], ['append', 'replace']);
  assert.deepEqual([...slotModes('settings.plugin.section')], ['append']);
});

test('插件页面路由与页面槽位派生同一套键，地址栏可往返', () => {
  const key = pluginRoute('Device App Catalog', '应用目录');
  assert.equal(key, 'plugin:device-app-catalog:page-', '中文页面名必须落到合法字符集，而不是空串');
  const latin = pluginRoute('device-app-catalog', 'catalog');
  assert.equal(latin, 'plugin:device-app-catalog:catalog');
  assert.ok(isPluginRoute(latin));
  assert.equal(isPluginRoute('devices'), false);
  assert.deepEqual(splitPluginRoute(latin), {
    pluginId: 'device-app-catalog',
    page: 'catalog',
  });
  assert.equal(routeHash(latin), 'plugin/device-app-catalog/catalog');
  assert.equal(routeHash('devices'), 'devices');
  assert.equal(parseProductRoute(`#/${routeHash(latin)}`), latin, '地址栏解析必须还原同一个键');
  assert.equal(parseProductRoute('#plugin/device-app-catalog/catalog'), latin);
  assert.equal(parseProductRoute('#devices?tab=apps'), 'devices');
  assert.equal(parseProductRoute('#/不存在的页面'), 'devices');
  // 路由键派生出来的槽位必须与模块自己算出的页面槽位一致，否则挂载会静默落空。
  assert.equal(routeSlotId(latin), pageSlotId('device-app-catalog', 'catalog'));
  assert.equal(routeSlotId(latin), 'page.device-app-catalog.catalog');
  assert.deepEqual([...slotModes(routeSlotId(latin))], ['replace']);
  assert.ok(isKnownSlot(routeSlotId(latin)));
});
