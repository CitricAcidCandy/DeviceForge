import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { MarketplaceEntry } from '../plugins/marketplace/src/model/index.ts';
import type { BrowserCatalog } from '../plugins/marketplace/src/browser-management.ts';
import type {
  InstallationClientState, PluginInstallation,
} from '../plugins/marketplace/src/workbench/installations.ts';
import type {
  BrowserRuntime, InstallationBrowserStatus,
} from '../plugins/marketplace/src/workbench/browser-state.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const entry: MarketplaceEntry = {
  metadata_version: 1, id: 'example-release', name: '示例配套插件', kind: 'plugin', version: '1.0.0',
  summary: '服务器和浏览器配套功能', description: '', keywords: [], categories: [], applies_to: ['deviceforge'],
  supports_mcp: 'none', supports_agent: false, restart_policy: 'plugin_reload', platforms: [], architectures: [],
  details: { release_format: 1 }, source: 'http://market.test', sourceName: '单元市场', resource_id: 'a'.repeat(64),
};
function installation(changes: Partial<PluginInstallation> = {}): PluginInstallation {
  return {
    id: entry.id, version: entry.version, revision: 'b'.repeat(64), enabled: true, status: 'enabled',
    name: entry.name, summary: entry.summary, description: '',
    components: [
      { id: 'example.browser', kind: 'browser', version: '1.0.0', entryPath: 'browser/index.js',
        revision: 'c'.repeat(64), entryUrl: '/api/v2/plugins/example/browser/index.js' },
      { id: 'example.tools', kind: 'browser', version: '1.0.0', entryPath: 'tools/index.js',
        revision: 'd'.repeat(64), entryUrl: '/api/v2/plugins/example/tools/index.js' },
      { id: 'example.server', kind: 'server', version: '1.0.0', entryPath: 'server/index.mjs',
        revision: 'e'.repeat(64), entryUrl: null },
    ], ...changes,
  };
}
function client(phase: InstallationClientState['phase'], changes: Partial<InstallationClientState> = {}): InstallationClientState {
  return { id: entry.id, revision: 'b'.repeat(64), phase, message: null, logId: null, ...changes };
}
const actions = {
  onDetail() {}, onDownload() {}, onInstall() {}, onRemove() {}, onConfigure() {}, onSetEnabled() {},
};
const loaded: readonly BrowserRuntime[] = [
  { id: 'example.browser', generation: 3, state: 'loaded' },
  { id: 'example.tools', generation: 4, state: 'loaded' },
];
async function cardFixture(unit: TestContext) {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><div id="card"></div></body></html>',
    { url: 'http://market.test', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    getComputedStyle: browser.window.getComputedStyle.bind(browser.window), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let network = 0;
  unit.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('此控件单元不允许真实联网'); });
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const releaseUi = installPublicUi();
  const { MarketplaceCard } = await import('../plugins/marketplace/src/workbench/components/MarketplaceCard/index.tsx');
  const target = browser.window.document.getElementById('card'); assert.ok(target);
  const root = createRoot(target);
  unit.after(async () => {
    try { await act(async () => { root.unmount(); }); await releaseUi(); }
    finally {
      parser.dispose(); browser.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  return { MarketplaceCard, target, root, network: () => network };
}

test('服务器启用但本客户端未启用时显示显式启用入口，渲染不派发且单击只回调一次', async (unit) => {
  const f = await cardFixture(unit);
  let retries = 0;
  const browserStatus: InstallationBrowserStatus = { phase: 'missing', canActivate: true };
  const props = { entry, installation: installation(), installedTab: true, installed: { version: entry.version },
    clientState: client('disabled'), browserStatus, busy: false, ...actions, onRetryBrowser() { retries++; } };
  const html = renderToStaticMarkup(React.createElement(f.MarketplaceCard, props));
  assert.ok(html.includes('本客户端界面未启用'), '服务端已启用不能省略本客户端未启用提示');
  assert.ok(html.includes('服务器已启用'), '含浏览器组件的安装须区分服务器和本客户端状态');
  await act(async () => { f.root.render(React.createElement(f.MarketplaceCard, props)); });
  const activate = [...f.target.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '启用本客户端');
  assert.ok(activate, '已启用安装缺少本客户端的显式启用按钮');
  assert.equal(activate.disabled, false);
  assert.equal(retries, 0);
  await act(async () => { f.root.render(React.createElement(f.MarketplaceCard, { ...props, busy: true })); });
  const busyActivate = [...f.target.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '启用本客户端');
  assert.ok(busyActivate);
  assert.equal(busyActivate.disabled, true);
  await act(async () => { busyActivate.click(); });
  assert.equal(retries, 0);
  await act(async () => {
    f.root.render(React.createElement(f.MarketplaceCard, { ...props, clientState: undefined }));
  });
  const missingActivate = [...f.target.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '启用本客户端');
  assert.ok(missingActivate);
  await act(async () => { missingActivate.click(); });
  assert.equal(retries, 1);
  assert.equal(f.network(), 0);
});

test('只有当前修订客户端启用且全部浏览器组件实际加载才就绪，缺失或旧状态可显式激活', async () => {
  const { installationBrowserStatus: status } = await import('../plugins/marketplace/src/workbench/browser-state.ts');
  const value = installation();
  assert.deepEqual(status(value, client('enabled'), loaded), { phase: 'ready', canActivate: false });
  assert.deepEqual(status(value, client('enabled'), loaded.slice(0, 1)), { phase: 'missing', canActivate: true });
  assert.deepEqual(status(value, client('disabled'), loaded), { phase: 'missing', canActivate: true });
  assert.deepEqual(status(value, undefined, loaded), { phase: 'missing', canActivate: true });
  assert.deepEqual(status(value, client('enabled', { revision: 'old-revision' }), loaded), { phase: 'missing', canActivate: true });
  assert.deepEqual(status(value, client('enabled', { id: 'foreign-installation' }), loaded), { phase: 'missing', canActivate: true });
  assert.deepEqual(status(value, undefined, []), { phase: 'missing', canActivate: true });
});

test('当前激活与任一所属组件加载中均禁止重复激活，不把其他插件或旧修订激活当在途', async () => {
  const { installationBrowserStatus: status } = await import('../plugins/marketplace/src/workbench/browser-state.ts');
  const value = installation();
  assert.deepEqual(status(value, client('activating'), loaded), { phase: 'loading', canActivate: false });
  const loading: readonly BrowserRuntime[] = [{ id: 'example.tools', generation: 5, state: 'loading' }];
  assert.deepEqual(status(value, client('failed'), loading), { phase: 'loading', canActivate: false });
  assert.deepEqual(status(value, undefined, loading), { phase: 'loading', canActivate: false });
  assert.deepEqual(status(value, client('activating', { revision: 'old-revision' }), loaded),
    { phase: 'missing', canActivate: true });
  assert.deepEqual(status(value, client('enabled'), [...loaded, { id: 'unrelated', generation: 1, state: 'loading' }]),
    { phase: 'ready', canActivate: false });
});

test('未知目录禁止猜测激活，同修订真实失败允许原重试但旧修订失败只算当前缺失', async () => {
  const { installationBrowserStatus: status } = await import('../plugins/marketplace/src/workbench/browser-state.ts');
  const value = installation();
  assert.deepEqual(status(value, client('enabled'), null), { phase: 'unknown', canActivate: false });
  assert.deepEqual(status(value, client('failed'), null), { phase: 'unknown', canActivate: false });
  assert.deepEqual(status(value, client('failed'), loaded), { phase: 'failed', canActivate: true });
  assert.deepEqual(status(value, client('failed', { revision: 'old-revision' }), []), { phase: 'missing', canActivate: true });
});

test('无浏览器不提供客户端动作，停用配置及真实恢复受阻禁止启用而旧清理告警不阻断', async () => {
  const { installationBrowserStatus: status } = await import('../plugins/marketplace/src/workbench/browser-state.ts');
  const value = installation();
  const serverOnly = installation({ components: value.components.filter((component) => component.kind === 'server') });
  assert.deepEqual(status(serverOnly, undefined, null), { phase: 'not_required', canActivate: false });
  const blocked: PluginInstallation[] = [installation({ enabled: false }),
    installation({ status: 'configuration_required' }), installation({ status: 'dependencies_required' }),
    installation({ status: 'recovery_blocked', failure: { phase: 'commit_rollback', reason: '真实文件恢复受阻' } })];
  for (const item of blocked)
    assert.deepEqual(status(item, client('failed'), []), { phase: 'disabled', canActivate: false });
  for (const phase of ['component_cleanup', 'activation_cleanup'])
    assert.deepEqual(status(installation({ status: 'recovery_blocked', failure: { phase, reason: '旧回收告警' } }), undefined, []),
      { phase: 'missing', canActivate: true });
});

test('真实卡片加载中不暴露重复入口，服务端单组件无客户端动作，失败保留错误日志及原重试', async (unit) => {
  const f = await cardFixture(unit);
  const { installationBrowserStatus: status } = await import('../plugins/marketplace/src/workbench/browser-state.ts');
  let retries = 0;
  const value = installation();
  const common = { entry, installedTab: true, busy: false, ...actions, onRetryBrowser() { retries++; } };
  const loadingClient = client('activating');
  const loading = renderToStaticMarkup(React.createElement(f.MarketplaceCard, {
    ...common, installation: value, clientState: loadingClient, browserStatus: status(value, loadingClient, []),
  }));
  assert.ok(loading.includes('本客户端界面正在启用'), '在途激活需要明确标注客户端正在启用');
  assert.equal(loading.includes('启用本客户端'), false);
  assert.equal(loading.includes('重试本客户端'), false);
  const serverOnly = installation({ components: value.components.filter((component) => component.kind === 'server') });
  const server = renderToStaticMarkup(React.createElement(f.MarketplaceCard, {
    ...common, installation: serverOnly, browserStatus: status(serverOnly, undefined, []),
  }));
  assert.equal(server.includes('启用本客户端'), false);
  assert.equal(server.includes('重试本客户端'), false);
  assert.equal(server.includes('本客户端界面未启用'), false);
  for (const browserStatus of [status(value, undefined, null), status(installation({ enabled: false }), undefined, [])]) {
    const unavailable = renderToStaticMarkup(React.createElement(f.MarketplaceCard, {
      ...common, installation: value, browserStatus,
    }));
    assert.equal(unavailable.includes('启用本客户端'), false);
    assert.equal(unavailable.includes('重试本客户端'), false);
  }
  const failed = client('failed', { message: '本次模块入口真实失败', logId: 'original-failed-log' });
  const failedProps = { ...common, installation: value, clientState: failed, browserStatus: status(value, failed, []) };
  const failedHtml = renderToStaticMarkup(React.createElement(f.MarketplaceCard, failedProps));
  assert.ok(failedHtml.includes('本次模块入口真实失败'));
  assert.ok(failedHtml.includes('original-failed-log'));
  assert.ok(failedHtml.includes('重试本客户端'));
  assert.equal(retries, 0);
  await act(async () => { f.root.render(React.createElement(f.MarketplaceCard, failedProps)); });
  const retry = [...f.target.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '重试本客户端');
  assert.ok(retry);
  await act(async () => { retry.click(); });
  assert.equal(retries, 1);
  assert.equal(f.network(), 0);
});

test('浏览器目录保留合法运行实例，非法状态和重复实例身份均拒绝并保留原日志', async () => {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  try {
    const { decodeBrowserCatalog } = await import('../plugins/marketplace/src/workbench/catalog-validation.ts');
    const directory = { known: true, pending: false, entries: [], error: null, logId: null };
    const runtime = loaded.map(({ id, generation, state }) => ({ id, generation, state }));
    const catalog: BrowserCatalog = {
      snapshotVersion: 1, packages: directory, installations: directory,
      runtime, bundled: [], clients: [], progress: null, cleanup: [], workspaceCleanup: [],
    };
    const decoded = decodeBrowserCatalog(catalog, 'runtime-directory-log');
    assert.deepEqual(decoded.runtime, runtime);
    assert.equal(decoded.known, true);
    for (const invalidRuntime of [
      [{ id: 'example.browser', generation: 3, state: 'disabled' }],
      [{ id: 'example.browser', generation: 3, state: 'loaded' },
        { id: 'example.browser', generation: 4, state: 'loading' }],
    ]) {
      assert.throws(() => decodeBrowserCatalog({ ...catalog, runtime: invalidRuntime }, 'original-invalid-runtime-log'),
        (error) => error instanceof Error && 'code' in error && error.code === 'invalid_marketplace_management_result' &&
          'logId' in error && error.logId === 'original-invalid-runtime-log');
    }
  } finally { parser.dispose(); }
});
