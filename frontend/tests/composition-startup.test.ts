import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import type { HostContext, WorkspacePageInfo } from '../src/plugin-sdk/index.ts';
import { DEVICE_APPS_VIEW, DEVICE_APPS_INSTANCE_ID, DEVICE_SCREEN_VIEW, DEVICES_WORKSPACE_ID } from '../plugins/devices/src/contracts.ts';
import { requestUrl, success } from './fixtures.ts';

const parser = registerCompositionStartupImports();
after(parser.dispose);
const { manifestPluginSources } = await import('../src/app/composition/manifest-sources.ts');
const { createProductPlatformServices } = await import('../src/app/product/platform-services.ts');

const baseUrl = 'http://127.0.0.1:7031';
const directoryPaths = ['/api/v2/plugin-packages/browser', '/api/v2/plugin-installations'];
const manifestFiles = globSync('plugins/*/manifest.json', { cwd: fileURLToPath(new URL('../', import.meta.url)) })
  .map((path) => path.replaceAll('\\', '/')).sort();
const routes = new Map([
  ['/devices', 'deviceforge_devices'], ['/files', 'deviceforge_files'],
  ['/tasks', 'deviceforge_tasks'], ['/frida', 'deviceforge_frida'],
  ['/automation', 'deviceforge_automation'], ['/analysis', 'deviceforge_analysis'],
  ['/performance', 'deviceforge_performance'],
  ['/terminal', 'deviceforge_terminal'],
  ['/ai', 'deviceforge_ai'], ['/settings', 'deviceforge_settings'],
  ['/marketplace', 'deviceforge_marketplace'],
]);
const toggleRoutes = new Map([
  ['/files', 'deviceforge_files'], ['/terminal', 'deviceforge_terminal'],
  ['/ai', 'deviceforge_ai'], ['/marketplace', 'deviceforge_marketplace'],
]);

function realSources() {
  const manifests: Record<string, unknown> = {}, entries: Record<string, () => Promise<unknown>> = {};
  assert.ok(manifestFiles.length > 0, '真实来源目录不能为空，不能用空目录证明启动成功');
  for (const key of manifestFiles) {
    manifests[key] = JSON.parse(readFileSync(new URL(`../${key}`, import.meta.url), 'utf8'));
    const entry = key.replace('manifest.json', 'src/index.ts');
    entries[entry] = () => import(new URL(`../${entry}`, import.meta.url).href);
  }
  const directory = manifestPluginSources(manifests, entries);
  assert.deepEqual(directory.diagnostics, [], '真实开发清单必须能被现行来源目录接受');
  assert.equal(directory.sources.length, manifestFiles.length);
  return directory.sources;
}
function persistence() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
function providers(pages: readonly WorkspacePageInfo[], route: string) {
  return pages.filter((page) => page.route === route).map((page) => page.pluginId);
}
function unique(pages: readonly WorkspacePageInfo[]) {
  assert.equal(new Set(pages.map((page) => page.route)).size, pages.length,
    '最终公开目录不能同时保留同址的新旧页面');
}
function onlyDirectoryReads(network: readonly string[]) {
  assert.deepEqual([...network].sort(), [...directoryPaths].sort(),
    '成功激活仅允许两类只读安装目录核对，不得以隐式业务请求或视图挂载换取');
}

async function fixture(saved = persistence()) {
  assert.deepEqual(parser.diagnostics, [], '真实独立工程的公开出口必须可解析');
  const browser = new JSDOM('<!doctype html><html><body></body></html>');
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: browser.window });
  const network: string[] = [];
  const services = createProductPlatformServices({
    baseUrl, panelTarget: () => null, workspaceStorage: null,
    officialPlugins: { sources: realSources(), persistence: saved },
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      network.push(path);
      if (directoryPaths.includes(path) && init?.method === 'GET') return success([]);
      throw new Error('启动目录单元禁止联网或执行业务');
    },
  });
  try {
    // 跟随 main 的登记顺序，不启动默认联网探测，也不选择或挂载外壳与业务视图。
    const { createDeviceViewsBridge } = await import('../src/app/product/device-views.tsx');
    const { createLegacyCompositionAdapter } = await import('../src/app/composition/legacy-adapters.ts');
    for (const plugin of [
      createDeviceViewsBridge(services),
      createLegacyCompositionAdapter(services.runtime.extensions),
    ]) {
      services.runtime.bundledPlugins.register({ id: plugin.id, trusted: true, plugin });
      await services.runtime.webPlugins.load(plugin.id);
    }
    const ui = services.runtime.host.ui;
    const official = services.officialPlugins;
    assert.ok(ui && official);
    return {
      services, ui, official, network, saved,
      async dispose() {
        try { await services.dispose(); }
        finally {
          browser.window.close();
          if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
          else Reflect.deleteProperty(globalThis, 'self');
        }
      },
    };
  } catch (error) {
    await services.dispose();
    browser.window.close();
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else Reflect.deleteProperty(globalThis, 'self');
    throw error;
  }
}

test('真实清单工厂经产品 runtime 启动，全部业务页面只由独立插件登记', async () => {
  const f = await fixture();
  try {
    const before = f.ui.catalog().pages;
    assert.deepEqual(before, [], '独立业务启动前不登记任何旧宿主业务页面');
    unique(before);
    const result = await f.official.start(f.services.runtime.host.signal);
    assert.equal(result.length, manifestFiles.length);
    assert.deepEqual(result.filter((entry) => entry.phase !== 'loaded'), [],
      JSON.stringify(result));
    const diagnostics = f.services.runtime.webPlugins.diagnosticSnapshot();
    for (const entry of result)
      assert.equal(diagnostics.find((item) => item.id === entry.id)?.state, 'loaded', entry.id);
    const pages = f.ui.catalog().pages;
    for (const [route, id] of routes) assert.deepEqual(providers(pages, route), [id]);
    assert.equal(diagnostics.some((entry) => entry.id === 'host_legacy_pages'), false);
    assert.deepEqual(providers(pages, '/ai'), ['deviceforge_ai']);
    unique(pages);
    assert.deepEqual(f.services.routeCatalog?.snapshot().diagnostics, []);
    assert.equal(f.services.runtime.host.extensions?.points?.list({ id: 'host.shell', version: '1' })
      .filter((entry) => entry.provider.pluginId === 'deviceforge_shell' && entry.state === 'active').length, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const services = f.services.runtime.host.services?.catalog() ?? [];
    for (const id of ['host.ai-sdk', 'host.ai-sdk.stream', 'host.performance', 'host.browser-plugins', 'host.ui-directory'])
      assert.equal(services.filter((entry) => entry.service.id === id && entry.available).length, 1, id);
    onlyDirectoryReads(f.network);
  } finally { await f.dispose(); }
});

test('真实 runtime 不把缺失业务服务假报可用，功能等待不发布成功页面', async () => {
  const f = await fixture();
  const contexts: HostContext[] = [];
  let activated = 0;
  const ref = { id: 'startup.absent_business', version: '1' };
  try {
    await f.official.start(f.services.runtime.host.signal);
    f.services.runtime.bundledPlugins.register({
      id: 'startup_service_consumer', trusted: true,
      plugin: {
        id: 'startup_service_consumer', version: '1', apiVersion: 2, panels: [],
        async activate(context) {
          contexts.push(context);
          assert.ok(context.services);
          context.services.whenAvailable('business', [ref], (feature) => {
            activated++;
            feature.ui?.register({ pages: [{
              id: 'startup_service_consumer.page', title: '不能伪造成功', route: '/startup-missing',
              mount: async () => () => {},
            }] });
          });
        },
      },
    });
    await f.services.runtime.webPlugins.load('startup_service_consumer');
    const context = contexts[0];
    assert.ok(context?.services);
    assert.equal(activated, 0);
    assert.deepEqual(context.services.diagnostics().map((entry) => ({
      id: entry.featureId, state: entry.state, missing: entry.missing,
    })), [{ id: 'business', state: 'waiting', missing: [ref] }]);
    assert.equal(f.ui.catalog().pages.some((page) => page.route === '/startup-missing'), false);
    assert.equal(context.services.catalog().some((entry) => entry.service.id === ref.id), false);
    const service = context.services;
    await assert.rejects(async () => service.call(ref, {}, context.signal), { code: 'service_unavailable' });
    onlyDirectoryReads(f.network);
  } finally { await f.dispose(); }
});

test('独立页面停用和再次启动均不恢复旧页面，重新启用只恢复该插件自己的页面', async () => {
  const saved = persistence();
  const first = await fixture(saved);
  try {
    await first.official.start(first.services.runtime.host.signal);
    assert.deepEqual(providers(first.ui.catalog().pages, '/files'), ['deviceforge_files']);
    for (const [route, id] of toggleRoutes) {
      assert.deepEqual(providers(first.ui.catalog().pages, route), [id]);
      await first.official.setEnabled(id, false, first.services.runtime.host.signal);
      assert.deepEqual(providers(first.ui.catalog().pages, route), []);
      assert.equal(first.official.snapshot().find((entry) => entry.id === id)?.phase, 'disabled');
    }
    unique(first.ui.catalog().pages);
    onlyDirectoryReads(first.network);
  } finally { await first.dispose(); }

  const next = await fixture(saved);
  try {
    // 主入口已退出旧页面装配，偏好恢复前也不会短暂展示停用业务。
    for (const route of toggleRoutes.keys()) assert.deepEqual(providers(next.ui.catalog().pages, route), []);
    const states = await next.official.start(next.services.runtime.host.signal);
    const disabledIds = new Set(toggleRoutes.values());
    for (const id of disabledIds) assert.equal(states.find((entry) => entry.id === id)?.phase, 'disabled');
    assert.deepEqual(states.filter((entry) => !disabledIds.has(entry.id) && entry.phase !== 'loaded'), []);
    for (const route of toggleRoutes.keys()) assert.deepEqual(providers(next.ui.catalog().pages, route), []);
    for (const [route, id] of toggleRoutes) {
      await next.official.setEnabled(id, true, next.services.runtime.host.signal);
      assert.deepEqual(providers(next.ui.catalog().pages, route), [id]);
    }
    unique(next.ui.catalog().pages);
    onlyDirectoryReads(next.network);
  } finally { await next.dispose(); }
});

test('设备应用独立停用保留布局和缺失占位，不恢复宿主应用；重启只建立新代提供者', async () => {
  const f = await fixture();
  try {
    await f.official.start(f.services.runtime.host.signal);
    const initial = f.ui.snapshot().instances.find((instance) => instance.instanceId === DEVICE_APPS_INSTANCE_ID);
    assert.ok(initial);
    assert.deepEqual(initial.provider, DEVICE_APPS_VIEW);
    assert.equal(initial.state, 'ready');
    const layout = f.ui.readLayout(DEVICES_WORKSPACE_ID);
    assert.ok(layout);
    await f.official.setEnabled(DEVICE_APPS_VIEW.pluginId, false, f.services.runtime.host.signal);
    const missing = f.ui.snapshot().instances.find((instance) => instance.instanceId === DEVICE_APPS_INSTANCE_ID);
    assert.ok(missing);
    assert.equal(missing.reason, 'provider_missing');
    assert.deepEqual(missing.provider, DEVICE_APPS_VIEW);
    assert.deepEqual(f.ui.readLayout(DEVICES_WORKSPACE_ID), layout);
    assert.equal(f.ui.catalog().views.some((view) => view.id === 'deviceforge_device_views.apps'), false);
    assert.equal(f.ui.catalog().views.some((view) => view.id === DEVICE_SCREEN_VIEW.viewId), true);
    assert.deepEqual(providers(f.ui.catalog().pages, '/devices'), ['deviceforge_devices']);
    await f.official.setEnabled(DEVICE_APPS_VIEW.pluginId, true, f.services.runtime.host.signal);
    const restored = f.ui.snapshot().instances.find((instance) => instance.instanceId === DEVICE_APPS_INSTANCE_ID);
    assert.ok(restored);
    assert.equal(restored.state, 'ready');
    assert.ok(restored.generation > missing.generation);
    assert.notEqual(restored.providerGeneration, initial.providerGeneration);
    assert.deepEqual(restored.target, initial.target);
    assert.deepEqual(f.ui.readLayout(DEVICES_WORKSPACE_ID), layout);
    onlyDirectoryReads(f.network);
  } finally { await f.dispose(); }
});
