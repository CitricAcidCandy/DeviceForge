import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose, HostContext, UiAccess, WorkspaceViewContext } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createPointRegistry } from '../src/plugins/points/registry.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const imports = registerCompositionStartupImports();
assert.deepEqual(imports.diagnostics, []);
const { mountShell } = await import('../plugins/default-shell/src/mount.tsx');
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { resolveTaskPage } = await import('../plugins/tasks/src/drawer-rules.ts');
imports.dispose();

type Page = 'ai' | 'devices' | 'other';
const definitions: Record<Page, { title: string; route: string; order: number }> = {
  ai: { title: 'AI 助手', route: '/ai', order: 80 },
  devices: { title: '设备', route: '/devices', order: 10 },
  other: { title: '另一业务', route: '/other', order: 1 },
};

function fixture(hash: string) {
  const browser = new JSDOM('<!doctype html><html><body><div id="shell"></div></body></html>', {
    url: `http://127.0.0.1:7031/${hash}`,
  });
  const document = browser.window.document, element = document.getElementById('shell');
  assert.ok(element);
  const target = element;
  const releasePublicUi = installPublicUi();
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const owner = new AbortController(), providers = new Set<AbortController>();
  const registry = createWorkspaceRegistry(), points = createPointRegistry();
  const pendingDisposals = new Set<Dispose>();
  const mounts: Record<Page, number> = { ai: 0, devices: 0, other: 0 };
  const releases: Record<Page, number> = { ai: 0, devices: 0, other: 0 };
  let businessCalls = 0, networkCalls = 0, directoryReads = 0;
  let disposeShell: Dispose = () => {};
  const forbidden = async (): Promise<never> => {
    businessCalls++;
    throw new Error('首页导航单元禁止调用业务通信');
  };
  const access = registry.access({ pluginId: 'deviceforge_shell', generation: 1, signal: owner.signal });
  const ui: UiAccess = {
    ...access,
    async mount(instanceId, root, signal) {
      signal.throwIfAborted();
      const snapshot = () => {
        const value = access.snapshot().instances.find((entry) => entry.instanceId === instanceId);
        assert.ok(value, '挂载必须来自真实工作区实例');
        return value;
      };
      const instance = snapshot();
      assert.ok(instance.provider);
      const entry = registry.resolvePage(instance.provider.viewId);
      assert.ok(entry?.definition.mount, '只能挂载实际已登记页面');
      return entry.definition.mount(root, context, {
        signal, snapshot,
        subscribeVisibility: (listener) => access.subscribe(() => listener(snapshot().visible)),
      });
    },
  };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, ui,
    listOperations: async () => { directoryReads++; return { data: [], logId: null }; },
    submit: forbidden, getJob: forbidden, cancelJob: forbidden,
    subscribeOperations: () => () => {},
    onDispose(dispose) {
      pendingDisposals.add(dispose);
      return () => { pendingDisposals.delete(dispose); return dispose(); };
    },
    extensions: {
      points: points.access({
        pluginId: 'deviceforge_shell', generation: 1, signal: owner.signal, track: (value) => value,
      }),
      catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: forbidden, callService: forbidden,
      subscribeEvent: () => () => {}, emitEvent() {},
      getState: () => undefined, setState() {}, subscribeState: () => () => {},
    },
  };
  for (const [name, value] of Object.entries({
    window: browser.window, document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => { networkCalls++; throw new Error('首页导航单元禁止真实网络'); },
  })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  function register(page: Page): Dispose {
    const provider = new AbortController();
    providers.add(provider);
    const definition = definitions[page], pluginId = `navigation_${page}`;
    return registry.access({ pluginId, generation: 1, signal: provider.signal }).register({
      pages: [{
        id: `${pluginId}.page`, title: definition.title, route: definition.route,
        navigation: { order: definition.order },
        async mount(root, _context, instance) {
          instance.signal.throwIfAborted();
          mounts[page]++;
          const input = document.createElement('input');
          input.dataset.pageDraft = page;
          input.setAttribute('aria-label', `${definition.title}草稿`);
          root.append(input);
          return () => { releases[page]++; input.remove(); };
        },
      }],
    });
  }
  function button(page: Page): HTMLButtonElement {
    const element = target.querySelector<HTMLButtonElement>(`nav[aria-label="工作区导航"] button[title="${definitions[page].title}"]`);
    assert.ok(element, '真实外壳应显示已登记页面的导航');
    return element;
  }
  function input(page: Page): HTMLInputElement {
    const element = target.querySelector<HTMLInputElement>(`input[data-page-draft="${page}"]`);
    assert.ok(element, '已选择页面应通过真实外壳挂载显示');
    return element;
  }
  function assertNoBusiness() {
    assert.equal(businessCalls, 0, '导航不得发起业务请求');
    assert.equal(networkCalls, 0, '所有通信必须由内存夹具处理');
    assert.equal(directoryReads, 1, '外壳公开目录查询应实际经过通信夹具');
  }
  async function start(visible?: boolean) {
    let instance: WorkspaceViewContext | undefined;
    if (visible !== undefined) {
      ui.register({ views: [{ id: 'deviceforge_shell.root', title: '候选外壳', mount: async () => () => {} }] });
      ui.open({ instanceId: 'deviceforge_shell.preview', workspaceId: 'host.shell',
        provider: { pluginId: 'deviceforge_shell', viewId: 'deviceforge_shell.root' }, visible });
      const resolved = registry.resolveView('deviceforge_shell.preview');
      assert.ok(resolved);
      instance = resolved.instance;
    }
    await act(async () => { disposeShell = await mountShell(target, context, instance); });
  }
  async function dispose() {
    try {
      await act(async () => { await disposeShell(); });
      owner.abort();
      for (const release of [...pendingDisposals]) await release();
    } finally {
      owner.abort();
      for (const provider of providers) provider.abort();
      points.dispose();
      registry.dispose();
      await releasePublicUi();
      browser.window.close();
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  }
  return { target, browser, ui, mounts, releases, register, button, input, start, dispose, assertNoBusiness,
    async showShell() { await act(async () => { ui.setVisible('deviceforge_shell.preview', true); }); } };
}

for (const hash of ['', '#/']) {
  test(`默认入口 ${hash || '空hash'} 等待晚到设备，先到AI不能成为首页`, { timeout: 4000 }, async () => {
    const f = fixture(hash);
    try {
      await f.start();
      await act(async () => { f.register('ai'); });
      assert.equal(f.button('ai').getAttribute('aria-current'), null);
      assert.match(f.target.querySelector('main')?.textContent ?? '', /当前页面暂不可用/);
      assert.deepEqual(f.mounts, { ai: 0, devices: 0, other: 0 }, '设备尚未登记时不能提前挂载AI');
      assert.equal(f.target.querySelector('input'), null);
      await act(async () => { f.register('devices'); });
      assert.equal(f.button('devices').getAttribute('aria-current'), 'page');
      assert.deepEqual(f.mounts, { ai: 0, devices: 1, other: 0 });
      assert.equal(f.target.querySelectorAll('input').length, 1);
      f.input('devices').value = '首页设备草稿';
      await act(async () => { f.register('other'); });
      assert.equal(f.button('devices').getAttribute('aria-current'), 'page');
      assert.equal(f.input('devices').value, '首页设备草稿');
      assert.deepEqual(f.mounts, { ai: 0, devices: 1, other: 0 });
      f.assertNoBusiness();
    } finally { await f.dispose(); }
  });

  test(`默认入口 ${hash || '空hash'} 的实际地址与任务归属一致，设备缺失不借其他业务`, async () => {
    const f = fixture(hash);
    try {
      f.register('other');
      const entries = f.browser.window.history.length;
      await f.start();
      const scope = () => resolveTaskPage(f.ui.catalog().pages, f.browser.window.location.hash);
      assert.equal(scope().page, null, '实际设备首页尚未就绪时，底栏不得把首个已加载业务当作当前页面');
      assert.equal(scope().reason, 'missing');
      assert.equal(f.browser.window.location.hash, '#/devices');
      assert.equal(f.browser.window.history.length, entries, '首页地址对齐不能添加一条虚假的后退历史');
      let remove: Dispose = () => {};
      await act(async () => { remove = f.register('devices'); });
      assert.equal(scope().page?.route, '/devices');
      assert.equal(f.button('devices').getAttribute('aria-current'), 'page');
      await act(async () => { void remove(); });
      assert.equal(scope().reason, 'missing');
      assert.equal(f.browser.window.location.hash, '#/devices');
      assert.match(f.target.querySelector('main')?.textContent ?? '', /页面提供者当前不可用/);
      f.assertNoBusiness();
    } finally { await f.dispose(); }
  });
}

for (const hash of ['#ai', '#/ai']) {
  test(`显式直达 ${hash} 等待AI，低order页面先后出现均不抢占`, { timeout: 4000 }, async () => {
    const f = fixture(hash);
    try {
      f.register('other');
      await f.start();
      assert.equal(f.button('other').getAttribute('aria-current'), null);
      assert.deepEqual(f.mounts, { ai: 0, devices: 0, other: 0 });
      await act(async () => { f.register('ai'); });
      assert.equal(f.button('ai').getAttribute('aria-current'), 'page');
      const draft = f.input('ai');
      draft.value = '显式直达的AI草稿';
      await act(async () => { f.register('devices'); });
      assert.equal(f.button('ai').getAttribute('aria-current'), 'page');
      assert.equal(f.input('ai'), draft);
      assert.equal(draft.value, '显式直达的AI草稿');
      assert.deepEqual(f.mounts, { ai: 1, devices: 0, other: 0 });
      assert.deepEqual(f.releases, { ai: 0, devices: 0, other: 0 });
      f.assertNoBusiness();
    } finally { await f.dispose(); }
  });
}

test('候选外壳在隐藏准备期间不改当前地址，正式可见后才对齐首页并通知观察者', async () => {
  const f = fixture('#/');
  let changes = 0;
  const observed: string[] = [];
  const changed = () => { changes++; observed.push(f.browser.window.location.hash); };
  f.browser.window.addEventListener('hashchange', changed);
  try {
    f.register('other');
    const entries = f.browser.window.history.length;
    await f.start(false);
    assert.equal(f.browser.window.location.hash, '#/');
    assert.equal(changes, 0);
    await act(async () => { f.register('devices'); });
    assert.equal(f.browser.window.location.hash, '#/');
    await f.showShell();
    assert.equal(f.browser.window.location.hash, '#/devices');
    assert.equal(f.browser.window.history.length, entries);
    assert.deepEqual(observed, ['#/devices']);
    assert.equal(resolveTaskPage(f.ui.catalog().pages, f.browser.window.location.hash).page?.route, '/devices');
    await f.showShell();
    assert.equal(changes, 1, '可见性不变不重复派发地址通知');
    f.assertNoBusiness();
  } finally {
    f.browser.window.removeEventListener('hashchange', changed);
    await f.dispose();
  }
});

test('设备晚到前用户主动切到AI后，目录更新不抢回首页或重挂草稿', { timeout: 4000 }, async () => {
  const f = fixture('#/');
  try {
    await f.start();
    await act(async () => { f.register('ai'); });
    await act(async () => { f.button('ai').click(); });
    const draft = f.input('ai');
    draft.value = '用户主动选择后的AI草稿';
    await act(async () => { f.register('devices'); f.register('other'); });
    assert.equal(f.button('ai').getAttribute('aria-current'), 'page');
    assert.equal(f.input('ai'), draft);
    assert.equal(draft.value, '用户主动选择后的AI草稿');
    assert.equal(f.target.querySelectorAll('input').length, 1);
    assert.deepEqual(f.mounts, { ai: 1, devices: 0, other: 0 });
    assert.deepEqual(f.releases, { ai: 0, devices: 0, other: 0 });
    f.assertNoBusiness();
  } finally { await f.dispose(); }
});

test('设备未登记或撤销时保留目标与不可用提示，不静默打开无关业务', { timeout: 4000 }, async () => {
  const f = fixture('#/devices');
  try {
    f.register('ai');
    f.register('other');
    await f.start();
    assert.deepEqual(f.mounts, { ai: 0, devices: 0, other: 0 });
    assert.equal(f.target.querySelector('nav[aria-label="工作区导航"] [aria-current="page"]'), null);
    let withdraw: Dispose = () => {};
    await act(async () => { withdraw = f.register('devices'); });
    assert.equal(f.button('devices').getAttribute('aria-current'), 'page');
    assert.deepEqual(f.mounts, { ai: 0, devices: 1, other: 0 });
    await act(async () => { await withdraw(); });
    assert.equal(f.target.querySelector('nav[aria-label="工作区导航"] [aria-current="page"]'), null);
    assert.match(f.target.querySelector('main')?.textContent ?? '', /页面提供者当前不可用/);
    assert.deepEqual(f.mounts, { ai: 0, devices: 1, other: 0 });
    f.assertNoBusiness();
  } finally { await f.dispose(); }
});

test('从显式业务页点击品牌首页回原设备页，不新增配置请求或重挂原草稿', { timeout: 4000 }, async () => {
  const f = fixture('#/ai');
  try {
    f.register('ai'); f.register('devices');
    await f.start();
    const aiDraft = f.input('ai');
    aiDraft.value = '品牌首页切换前草稿';
    const home = f.target.querySelector<HTMLButtonElement>('button[aria-label="设备工坊首页"]');
    assert.ok(home);
    await act(async () => { home.click(); });
    assert.equal(f.button('devices').getAttribute('aria-current'), 'page');
    assert.equal(f.target.querySelector('input[data-page-draft="ai"]'), null);
    assert.deepEqual(f.mounts, { ai: 1, devices: 1, other: 0 });
    await act(async () => { f.button('ai').click(); });
    assert.equal(f.input('ai'), aiDraft);
    assert.equal(aiDraft.value, '品牌首页切换前草稿');
    assert.deepEqual(f.mounts, { ai: 1, devices: 1, other: 0 });
    assert.deepEqual(f.releases, { ai: 0, devices: 0, other: 0 });
    f.assertNoBusiness();
  } finally { await f.dispose(); }
});
