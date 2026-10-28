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
import { deferred, job, success } from './fixtures.ts';
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

async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('槽位操作未在 300ms 内结束')), 300);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('持有替换租约时直接释放槽位，不等待自身串行队列', async () => {
  const host = dom();
  const adapter = await createNamedSlotAdapter([]);
  const release = await adapter.define({ id: 'area.demo', target: host });
  const lease = await adapter.acquire({
    slot: 'area.demo', pluginId: 'demo', generation: 1, componentId: 'demo.pane', mode: 'replace',
  }, new AbortController().signal);
  await within(Promise.resolve(release()));
  assert.equal(host.children.length, 0);
  await within(Promise.resolve(lease.dispose()));
  await adapter.dispose();
});

test('旧槽位释放函数重复晚到，不会删除同名新实例及新租约', async () => {
  const adapter = await createNamedSlotAdapter([]);
  const releaseOld = await adapter.define({ id: 'area.demo', target: dom() });
  await releaseOld();
  const host = dom();
  const releaseNew = await adapter.define({ id: 'area.demo', target: host });
  await releaseOld();
  const lease = await adapter.acquire({
    slot: 'area.demo', pluginId: 'demo', generation: 2, componentId: 'demo.pane', mode: 'append',
  }, new AbortController().signal);
  assert.equal(host.children.length, 1);
  await lease.dispose();
  await releaseNew();
  await adapter.dispose();
});

test('一个槽位的慢清理不阻塞另一个槽位，同槽位继续串行', async () => {
  const cleanup = deferred<void>();
  const entered = deferred<void>();
  const adapter = await createNamedSlotAdapter([]);
  const release = await adapter.define({
    id: 'area.slow', target: dom(), renderDefault: () => async () => {
      entered.resolve();
      await cleanup.promise;
    },
  });
  const pendingRelease = Promise.resolve(release());
  await entered.promise;
  let sameSlotDefined = false;
  const sameSlot = adapter.define({ id: 'area.slow', target: dom() }).then((dispose) => {
    sameSlotDefined = true;
    return dispose;
  });
  try {
    const releaseOther = await within(adapter.define({ id: 'area.other', target: dom() }));
    assert.equal(sameSlotDefined, false, '同槽位必须等旧实例清理结束');
    await releaseOther();
  } finally {
    cleanup.resolve();
    await pendingRelease;
    await (await sameSlot)();
    await adapter.dispose();
  }
});

test('关闭适配器与在途租约释放并发时都能收敛', async () => {
  const adapter = await createNamedSlotAdapter([{ id: 'area.demo', target: dom() }]);
  const lease = await adapter.acquire({
    slot: 'area.demo', pluginId: 'demo', generation: 1, componentId: 'demo.pane', mode: 'replace',
  }, new AbortController().signal);
  await within(Promise.all([adapter.dispose(), Promise.resolve(lease.dispose())]));
  await assert.rejects(adapter.acquire({
    slot: 'area.demo', pluginId: 'demo', generation: 2, componentId: 'demo.pane', mode: 'append',
  }, new AbortController().signal), /撤销/);
});

test('释放旧槽位后旧租约的迟到释放，不影响同名新槽位的替换租约', async () => {
  const adapter = await createNamedSlotAdapter([]);
  const oldRelease = await adapter.define({ id: 'area.demo', target: dom() });
  const request = {
    slot: 'area.demo', pluginId: 'demo', generation: 1, componentId: 'demo.pane', mode: 'replace' as const,
  };
  const oldLease = await adapter.acquire(request, new AbortController().signal);
  await within(Promise.resolve(oldRelease()));
  const host = dom();
  const releaseNew = await adapter.define({ id: 'area.demo', target: host });
  const current = await adapter.acquire({ ...request, generation: 2 }, new AbortController().signal);
  await oldLease.dispose();
  assert.equal(host.children.length, 1, '旧租约不能移除新租约');
  await assert.rejects(adapter.acquire({ ...request, generation: 3 }, new AbortController().signal), /已有替换/);
  await current.dispose();
  await releaseNew();
  await adapter.dispose();
});

test('关闭适配器会等待本槽位在途获取收口，取消后不再创建租约', async () => {
  const cleanup = deferred<void>();
  const entered = deferred<void>();
  const host = dom();
  const adapter = await createNamedSlotAdapter([{
    id: 'area.demo', target: host, renderDefault: () => async () => {
      entered.resolve();
      await cleanup.promise;
    },
  }]);
  const pending = adapter.acquire({
    slot: 'area.demo', pluginId: 'demo', generation: 1, componentId: 'demo.pane', mode: 'replace',
  }, new AbortController().signal);
  const cancelled = assert.rejects(pending, /撤销|取消/);
  await entered.promise;
  const closing = adapter.dispose();
  cleanup.resolve();
  await within(Promise.all([cancelled, closing]));
  assert.equal(host.children.length, 0);
});

test('默认清理失败可见且不锁住其它槽位或同名新实例', async () => {
  const adapter = await createNamedSlotAdapter([]);
  const release = await adapter.define({
    id: 'area.demo', target: dom(), renderDefault: () => () => { throw new Error('清理失败'); },
  });
  await assert.rejects(Promise.resolve(release()), /宿主槽位释放失败/);
  const releaseNew = await within(adapter.define({ id: 'area.demo', target: dom() }));
  await assert.rejects(Promise.resolve(release()), /宿主槽位释放失败/, '幂等释放保留原失败，不假装成功');
  const releaseOther = await within(adapter.define({ id: 'area.other', target: dom() }));
  await releaseOther();
  await releaseNew();
  await adapter.dispose();
});

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
  assert.equal(HOST_SLOTS.length, 14, '11 个路由槽位 + 2 个区域槽位 + 1 个全局工具槽位');
  assert.deepEqual(slotModes('developer.tools'), ['append']);
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

test('合法 100 字符插件身份不截断，路由与模块槽位派生保持一致', () => {
  for (const length of [64, 65, 99, 100]) {
    const id = `p${'a'.repeat(length - 2)}x`;
    const route = pluginRoute(id, '/catalog');
    assert.deepEqual(splitPluginRoute(route), { pluginId: id, page: 'catalog' });
    assert.equal(pageSlotId(id, '/catalog'), `page.${id}.catalog`);
    assert.equal(routeSlotId(route), pageSlotId(id, '/catalog'));
    assert.equal(parseProductRoute(`#/${routeHash(route)}`), route);
  }
  const prefix = `p${'a'.repeat(98)}`;
  assert.notEqual(pageSlotId(`${prefix}x`, 'catalog'), pageSlotId(`${prefix}y`, 'catalog'));
});

test('100 字符插件模块通过管理器挂载到路由派生的同一槽位', async () => {
  const id = `p${'a'.repeat(99)}`;
  const host = dom();
  const adapter = await createNamedSlotAdapter([]);
  const release = await adapter.define({ id: routeSlotId(pluginRoute(id, '/catalog')), target: host });
  const instance = runtime({ slotAdapter: adapter });
  try {
    register(instance, id, { modules: [{
      id: `${id}.catalog`, title: '长身份插件页面', route: '/catalog',
      async mount(target) { target.textContent = id; return () => { target.textContent = ''; }; },
    }] });
    await instance.webPlugins.load(id);
    await instance.extensions.mountModule(`${id}.catalog`);
    assert.equal(host.textContent, id);
    await instance.webPlugins.unload(id);
    assert.equal(host.children.length, 0);
  } finally {
    await instance.dispose();
    await release();
    await adapter.dispose();
  }
});
