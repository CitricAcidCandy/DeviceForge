import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import { legacyRouteSurfaces } from '../src/app/composition/legacy-route-surfaces.ts';
import { registerLegacySettings } from '../src/app/composition/legacy-settings.ts';
import { createRouteCatalog } from '../src/app/product/route-catalog.ts';
import type { UiAccess, WebPlugin, WorkspaceMount } from '../src/plugin-sdk/index.ts';
import { deferred } from './fixtures.ts';

async function fixture() {
  const browser = new JSDOM('<!doctype html><html><body><main></main></body></html>');
  const element = browser.window.document.querySelector('main');
  assert.ok(element);
  const target: HTMLElement = element;
  const slots = await createNamedSlotAdapter([]);
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    slotAdapter: slots,
    decorateWorkspaceMount: legacyRouteSurfaces(() => runtime.extensions),
    transport: async () => { throw new Error('兼容挂载不应发送业务请求'); },
  });
  async function load(plugin: WebPlugin) {
    runtime.bundledPlugins.register({ id: plugin.id, trusted: true, plugin });
    await runtime.webPlugins.load(plugin.id);
  }
  const access = runtime.host.ui;
  assert.ok(access?.mount);
  const ui: UiAccess = access;
  async function page(mount: WorkspaceMount, route = '/devices') {
    await load({ id: 'business', version: '1.0.0', apiVersion: 2, panels: [], async activate(context) {
      context.ui?.register({ pages: [{ id: 'business.page', title: '业务页', route, mount }] });
    } });
    ui.open({ instanceId: 'host.test', workspaceId: 'host.workspace', provider: { pluginId: 'business', viewId: 'business.page' } });
    assert.ok(ui.mount);
    return ui.mount('host.test', target, runtime.host.signal);
  }
  return { browser, target, slots, runtime, ui, load, page, async dispose() {
    await runtime.dispose(); await slots.dispose(); browser.window.close();
  } };
}
async function settled(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('兼容视图没有在定向单元期限内收敛');
}

test('旧模块按同一身份派生可挂载页面，路由目录不把兼容投影误报成冲突', async () => {
  const f = await fixture();
  const catalog = createRouteCatalog({ workspace: f.ui, modules: { snapshot: f.runtime.extensions.catalog, subscribe: f.runtime.extensions.subscribe } });
  try {
    await f.load({ id: 'old_plugin', version: '1.0.0', apiVersion: 2, panels: [], contributions: {
      modules: [{ id: 'old_plugin.main', title: '旧页面', route: '/my-page', mount: async (target) => { target.textContent = '旧模块真实内容'; return () => {}; } }],
    } });
    const page = f.ui.catalog().pages[0];
    assert.equal(page?.route, '/plugin/old_plugin/my-page');
    assert.equal(page?.pluginId, 'old_plugin');
    assert.equal(catalog.snapshot().entries.length, 1);
    assert.equal(catalog.snapshot().diagnostics.length, 0);
    f.ui.open({ instanceId: 'host.legacy', workspaceId: 'host.legacy', provider: { pluginId: 'old_plugin', viewId: 'old_plugin.main' } });
    assert.ok(f.ui.mount);
    const release = await f.ui.mount('host.legacy', f.target, f.runtime.host.signal);
    assert.match(f.target.textContent ?? '', /旧模块真实内容/);
    await f.runtime.webPlugins.unload('old_plugin');
    assert.equal(f.ui.catalog().pages.length, 0);
    assert.equal(catalog.snapshot().entries.length, 0);
    await release();
  } finally { catalog.dispose(); await f.dispose(); }
});

test('旧整页替换成功后才隐藏业务视图，恢复默认保留原草稿', async () => {
  const f = await fixture();
  try {
    const release = await f.page(async (target) => {
      const input = target.ownerDocument.createElement('input'); input.value = '未保存的草稿'; target.append(input);
      return () => {};
    });
    const input = f.target.querySelector('input'); assert.ok(input);
    await f.load({ id: 'replace', version: '1.0.0', apiVersion: 2, panels: [], contributions: {
      components: [{ id: 'replace.page', title: '旧替换', slot: 'route.devices', mode: 'replace', mount: async (target) => { target.textContent = '替换内容'; return () => {}; } }],
    } });
    await settled(() => !!input.parentElement?.hidden);
    assert.equal(f.target.querySelector('input'), input);
    const button = [...f.target.querySelectorAll('button')].find((item) => item.textContent === '恢复默认');
    assert.ok(button); button.click();
    await settled(() => !input.parentElement?.hidden);
    assert.equal(input.value, '未保存的草稿');
    await release();
  } finally { await f.dispose(); }
});

test('旧替换失败和受保护页替换不会隐藏原内容', async () => {
  const f = await fixture();
  try {
    const release = await f.page(async (target) => { target.textContent = '原设置'; return () => {}; }, '/settings');
    await f.load({ id: 'bad', version: '1.0.0', apiVersion: 2, panels: [], contributions: {
      components: [{ id: 'bad.page', title: '错误替换', slot: 'route.settings', mode: 'replace', mount: async () => { throw new Error('替换未完成'); } }],
    } });
    await settled(() => !!f.target.querySelector('button'));
    const fallback = f.target.querySelector('[data-deviceforge-surface]')?.lastElementChild;
    assert.equal(fallback?.getAttribute('hidden'), null);
    assert.match(f.target.textContent ?? '', /原设置/);
    await release();
  } finally { await f.dispose(); }
});

test('提供者撤销时立即释放旧槽位资格，晚到业务释放只归旧挂载', async () => {
  const f = await fixture();
  const entered = deferred<void>(), late = deferred<() => void>();
  let released = 0;
  try {
    const pending = f.page(async () => { entered.resolve(); return late.promise; });
    const rejected = assert.rejects(pending);
    await entered.promise;
    await f.runtime.webPlugins.unload('business');
    await rejected;
    const releaseSlot = await f.slots.define({ id: 'route.devices', target: f.target });
    await releaseSlot();
    late.resolve(() => { released++; });
    await settled(() => released === 1);
    assert.equal(f.target.textContent, '');
  } finally { late.resolve(() => { released++; }); await f.dispose(); }
});

test('设置兼容分组等待新设置扩展点，只在有旧组件时出现并保持真实挂载', async () => {
  const f = await fixture();
  const point = { id: 'deviceforge_settings.sections', version: '1' };
  try {
    await f.load({ id: 'legacy', version: '1.0.0', apiVersion: 2, panels: [], async activate(context) {
      registerLegacySettings(context, f.runtime.extensions, 'legacy');
    } });
    assert.equal(f.runtime.host.extensions?.points?.list(point).length, 0);
    await f.load({ id: 'widget', version: '1.0.0', apiVersion: 2, panels: [], contributions: {
      components: [{ id: 'widget.settings', title: '旧设置', slot: 'settings.plugin.section', mount: async (target) => {
        target.textContent = '旧设置组件'; return () => {};
      } }],
    } });
    assert.equal(f.runtime.host.extensions?.points?.list(point)[0]?.state, 'waiting');
    await f.load({ id: 'deviceforge_settings', version: '1.0.0', apiVersion: 2, panels: [], async activate(context) {
      context.extensions?.points?.define({ ...point, title: '插件扩展', modes: ['append'] });
    } });
    assert.equal(f.runtime.host.extensions?.points?.list(point)[0]?.state, 'active');
    f.ui.open({ instanceId: 'host.settings', workspaceId: 'host.settings', provider: { pluginId: 'legacy', viewId: 'legacy.settings-section' } });
    assert.ok(f.ui.mount);
    const release = await f.ui.mount('host.settings', f.target, f.runtime.host.signal);
    await settled(() => f.target.textContent?.includes('旧设置组件') === true);
    await f.runtime.webPlugins.unload('widget');
    assert.equal(f.runtime.host.extensions?.points?.list(point).length, 0);
    await release();
  } finally { await f.dispose(); }
});

test('独立应用主实例保留旧devices.apps追加与替换，额外实例不争用旧槽位', async () => {
  const f = await fixture();
  const provider = { pluginId: 'independent_apps', viewId: 'independent_apps.main' };
  try {
    await f.load({ id: provider.pluginId, version: '0.1.0', apiVersion: 2, panels: [],
      async activate(context) {
        context.ui?.register({ views: [{ id: provider.viewId, title: '独立应用', provides: ['device.apps'],
          mount: async (target) => {
            const input = target.ownerDocument.createElement('input'); input.value = '保留的应用草稿'; target.append(input);
            return () => { input.remove(); };
          },
        }] });
      },
    });
    await f.load({ id: 'deviceforge_devices', version: '0.1.0', apiVersion: 2, panels: [],
      async activate(context) {
        context.ui?.open({ instanceId: 'deviceforge_devices.apps.main', workspaceId: 'deviceforge_devices.workspace', provider });
        context.ui?.open({ instanceId: 'deviceforge_devices.tool.1', workspaceId: 'deviceforge_devices.workspace', provider });
      },
    });
    assert.ok(f.ui.mount);
    const release = await f.ui.mount('deviceforge_devices.apps.main', f.target, f.runtime.host.signal);
    const input = f.target.querySelector('input'); assert.ok(input);
    const extra = f.browser.window.document.createElement('aside'); f.target.append(extra);
    const releaseExtra = await f.ui.mount('deviceforge_devices.tool.1', extra, f.runtime.host.signal);
    assert.ok(extra.querySelector('input'));
    assert.equal(extra.querySelector('[data-deviceforge-surface]'), null);
    await f.load({ id: 'old_apps', version: '0.1.0', apiVersion: 2, panels: [], contributions: {
      components: [
        { id: 'old_apps.append', title: '追加应用功能', slot: 'devices.apps', mode: 'append', mount: async (target) => {
          target.textContent = '旧追加功能'; return () => {};
        } },
        { id: 'old_apps.replace', title: '应用别名', slot: 'devices.apps', mode: 'replace', mount: async (target) => {
          target.textContent = '旧替换内容'; return () => {};
        } },
      ],
    } });
    await settled(() => Boolean(input.parentElement?.hidden) && Boolean(f.target.textContent?.includes('旧追加功能')));
    assert.ok(f.target.textContent?.includes('旧替换内容'));
    const restore = f.target.querySelector<HTMLButtonElement>('button'); assert.ok(restore); restore.click();
    await settled(() => !input.parentElement?.hidden);
    assert.equal(input.value, '保留的应用草稿');
    assert.ok(extra.querySelector('input'));
    await releaseExtra(); await release();
  } finally { await f.dispose(); }
});
