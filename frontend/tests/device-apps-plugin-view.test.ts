import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { Dispose, WorkspaceInstance, WorkspaceViewContext } from '../src/plugin-sdk/index.ts';
import type { DeviceAppsServices } from '../plugins/device-apps/src/services.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

async function fixture(options: { replayOperations?: boolean } = {}) {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const { createDeviceAppsServices } = await import('../plugins/device-apps/src/services.ts');
  const { fixture: modelFixture, reference } = await import('./device-apps-plugin-fixtures.ts');
  const browser = new JSDOM('<!doctype html><html><body><div id="one"></div><div id="two"></div></body></html>',
    { url: 'http://127.0.0.1:7031', pretendToBeVisual: true });
  // 内存 DOM 没有布局滚动；此夹具只验证真实组件状态与菜单内容。
  browser.window.HTMLElement.prototype.scrollIntoView = () => {};
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    NodeFilter: browser.window.NodeFilter, HTMLSelectElement: browser.window.HTMLSelectElement,
    DocumentFragment: browser.window.DocumentFragment, HTMLInputElement: browser.window.HTMLInputElement,
    HTMLFormElement: browser.window.HTMLFormElement, HTMLButtonElement: browser.window.HTMLButtonElement,
    CustomEvent: browser.window.CustomEvent, MutationObserver: browser.window.MutationObserver,
    getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
    requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
    cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const removeUi = installPublicUi();
  const { resolveOwnedPortalRoot } = await import('../src/app/portal-ownership.ts');
  const { mountDeviceApps } = await import('../plugins/device-apps/src/view.tsx');
  const base = modelFixture(options), mounted: Dispose[] = [];
  const roots = ['one', 'two'].map((id) => browser.window.document.getElementById(id))
    .filter((root): root is HTMLElement => root !== null);
  for (const root of roots) {
    root.dataset.deviceforgePlugin = 'deviceforge_device_apps';
    root.dataset.deviceforgeGeneration = '3';
    root.dataset.deviceforgeExtension = `workspace.apps.${root.id}.1`;
  }
  const one = createDeviceAppsServices(base.context, reference);
  const two = createDeviceAppsServices(base.context, reference);
  function view(id: string) {
    let current: WorkspaceInstance = {
      instanceId: id, workspaceId: 'apps_unit.workspace', pluginId: 'apps_unit',
      provider: { pluginId: 'deviceforge_device_apps', viewId: 'deviceforge_device_apps.main' },
      target: { kind: 'device', reference: { ...reference } }, visible: true,
      generation: 1, providerGeneration: 1, state: 'ready', reason: null,
    };
    const listeners = new Set<(visible: boolean) => void>();
    const instance: WorkspaceViewContext = {
      signal: base.context.signal, snapshot: () => current,
      subscribeVisibility(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    return {
      instance,
      listenerCount: () => listeners.size,
      setVisible(visible: boolean) {
        current = { ...current, visible };
        for (const listener of [...listeners]) listener(visible);
      },
    };
  }
  async function mount(target: HTMLElement, services: DeviceAppsServices, instance: WorkspaceViewContext) {
    let release: Dispose = () => {};
    await act(async () => { release = mountDeviceApps(target, services, instance); });
    mounted.push(release);
    return release;
  }
  return {
    base, browser, roots, one, two, view, mount, resolveOwnedPortalRoot,
    async dispose() {
      try {
        await act(async () => {
          for (const release of mounted) await release();
          await base.dispose();
        });
      } finally {
        await removeUi(); parser.dispose(); browser.window.close();
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}

function search(root: ParentNode) {
  const input = root.querySelector<HTMLInputElement>('input[aria-label="筛选应用标识"]');
  assert.ok(input);
  return input;
}
async function type(input: HTMLInputElement, text: string) {
  const browser = input.ownerDocument.defaultView;
  assert.ok(browser);
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
}
function button(root: ParentNode, text: string) {
  const result = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent === text);
  assert.ok(result, `没有找到按钮：${text}`);
  return result;
}

test('原应用界面不自动读取，隐藏及DOM重挂保留草稿，多实例字段和上传标签独立', async () => {
  const f = await fixture(), [root, other] = f.roots;
  assert.ok(root && other);
  try {
    const instance = f.view('apps.one');
    const release = await f.mount(root, f.one, instance.instance);
    assert.match(root.textContent ?? '', /安装到当前设备/);
    await type(search(root), 'com.example');
    await act(async () => { instance.setVisible(false); });
    assert.equal(root.querySelector('[data-device-view]')?.hasAttribute('hidden'), true);
    assert.equal(search(root).value, 'com.example');
    await act(async () => { instance.setVisible(true); await release(); });
    await f.mount(root, f.one, instance.instance);
    assert.equal(search(root).value, 'com.example');
    await f.mount(other, f.two, f.view('apps.two').instance);
    assert.equal(search(other).value, '');
    const upload = root.querySelector<HTMLInputElement>('input[type="file"]');
    const secondUpload = other.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(upload && secondUpload);
    assert.notEqual(upload.id, secondUpload.id);
    assert.ok(root.querySelector(`label[for="${upload.id}"]`));
    assert.equal(f.base.counts.invocations, 0);
    assert.equal(f.base.counts.uploads, 0);
  } finally { await f.dispose(); }
});

test('应用视图在快照与订阅间变为可见时校准当前状态，保留多实例草稿并撤销订阅', async () => {
  const f = await fixture(), [root, other] = f.roots;
  assert.ok(root && other);
  try {
    const current = f.view('apps.one'), second = f.view('apps.two');
    const releaseOther = await f.mount(other, f.two, second.instance);
    const otherInput = search(other);
    await type(otherInput, 'com.other.draft');
    const otherSubscriptions = second.listenerCount();
    assert.ok(otherSubscriptions > 0);
    current.setVisible(false);
    let subscriptions = 0, visibilityChanged = false;
    const instance: WorkspaceViewContext = {
      ...current.instance,
      subscribeVisibility(listener) {
        subscriptions++;
        if (!visibilityChanged) {
          visibilityChanged = true;
          // 模拟父视图在读取快照后、登记监听前切换；原事件不会回放给尚未登记的监听。
          current.setVisible(true);
        }
        return current.instance.subscribeVisibility(listener);
      },
    };
    const release = await f.mount(root, f.one, instance);
    assert.equal(visibilityChanged, true, '必须实际发生渲染与订阅之间的可见性变化');
    assert.ok(subscriptions > 0);
    assert.equal(instance.snapshot().visible, true);
    const section = root.querySelector<HTMLElement>('[data-device-view="apps"]'); assert.ok(section);
    assert.equal(section.hidden, false, '首次订阅必须校准最新可见状态，不能等待下一次事件');
    assert.equal(section.hasAttribute('inert'), false, 'React section不应保留禁用交互属性');
    assert.equal(root.inert, false, '根容器交互状态也必须按当前快照校准');
    const input = search(root);
    await type(input, 'com.current.draft');
    await act(async () => { current.setVisible(false); });
    assert.equal(section.hidden, true); assert.equal(root.inert, true);
    await act(async () => { current.setVisible(true); });
    assert.equal(section.hidden, false); assert.equal(root.inert, false);
    assert.equal(search(root), input);
    assert.equal(input.value, 'com.current.draft');
    assert.equal(search(other), otherInput);
    assert.equal(otherInput.value, 'com.other.draft');
    assert.equal(second.listenerCount(), otherSubscriptions);
    await act(async () => { await release(); });
    assert.equal(current.listenerCount(), 0, '卸载必须撤销当前视图的全部可见性订阅');
    assert.equal(root.childElementCount, 0); assert.equal(root.inert, true);
    assert.equal(search(other), otherInput);
    assert.equal(otherInput.value, 'com.other.draft');
    assert.equal(other.inert, false);
    assert.equal(second.listenerCount(), otherSubscriptions);
    await act(async () => { current.setVisible(false); current.setVisible(true); });
    assert.equal(root.childElementCount, 0, '卸载后的事件不能复活旧视图');
    await act(async () => { await releaseOther(); });
    assert.equal(second.listenerCount(), 0);
    assert.equal(f.base.counts.operationReads, 0);
    assert.equal(f.base.counts.invocations, 0, '可见性校准不能自动调用设备应用操作');
    assert.equal(f.base.counts.uploads, 0);
  } finally { await f.dispose(); }
});

test('根交互校准读取失败保留原错误并撤销订阅与DOM，独立新挂载仍可继续', async () => {
  const f = await fixture(), root = f.roots[0];
  assert.ok(root);
  try {
    const current = f.view('apps.failed-calibration');
    const expected = new Error('根交互校准快照读取失败');
    let subscriptions = 0, failedReads = 0, deviceSubscriptions = 0;
    const instance: WorkspaceViewContext = {
      ...current.instance,
      snapshot() {
        if (subscriptions >= 2) { failedReads++; throw expected; }
        return current.instance.snapshot();
      },
      subscribeVisibility(listener) {
        // 第一处来自视图effect，第二处来自挂载入口的根交互监听；后者建立后才令读取失败。
        const release = current.instance.subscribeVisibility(listener);
        subscriptions++;
        return release;
      },
    };
    const services: DeviceAppsServices = {
      ...f.one,
      devices: {
        ...f.one.devices,
        subscribe(listener) {
          const release = f.one.devices.subscribe(listener);
          deviceSubscriptions++;
          return () => { deviceSubscriptions--; return release(); };
        },
      },
    };
    await assert.rejects(f.mount(root, services, instance), (error: unknown) => error === expected,
      '失败必须返回同一个校准Error，不被清理回执或React错误替换');
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    assert.equal(subscriptions, 2, '必须在视图与根交互两处监听建立后命中校准失败');
    assert.equal(failedReads, 1);
    assert.equal(current.listenerCount(), 0, '视图与根交互可见性监听均应撤销');
    assert.equal(deviceSubscriptions, 0, '所属设备快照监听应随React根和根交互监听一并释放');
    assert.equal(root.childElementCount, 0, '失败挂载不得留下React内容');
    assert.equal(root.inert, true);
    const fresh = f.view('apps.independent');
    const release = await f.mount(root, f.one, fresh.instance);
    const section = root.querySelector<HTMLElement>('[data-device-view="apps"]'); assert.ok(section);
    assert.equal(section.hidden, false);
    assert.equal(root.inert, false, '旧失败不能冻结同根独立新挂载');
    await type(search(root), 'com.independent.draft');
    assert.equal(search(root).value, 'com.independent.draft');
    await act(async () => { await release(); });
    assert.equal(fresh.listenerCount(), 0);
    assert.equal(root.childElementCount, 0);
    assert.equal(f.base.counts.operationReads, 0);
    assert.equal(f.base.counts.invocations, 0);
    assert.equal(f.base.counts.uploads, 0);
  } finally { await f.dispose(); }
});

test('显式读取展示真实应用行和详情菜单；隐藏关闭Portal，原安装与7种分析操作仍在', async () => {
  const f = await fixture({ replayOperations: false }), root = f.roots[0];
  assert.ok(root);
  try {
    const instance = f.view('apps.one');
    await f.mount(root, f.one, instance.instance);
    const read = root.querySelector<HTMLButtonElement>('button[aria-label="读取应用列表"]');
    assert.ok(read);
    assert.equal(f.base.counts.operationReads, 0);
    assert.equal(read.disabled, false);
    await act(async () => { read.click(); });
    assert.equal(f.base.counts.operationReads, 1);
    assert.equal(f.base.counts.invocations, 1);
    assert.match(root.textContent ?? '', /com.example.app/);
    const menu = root.querySelector<HTMLButtonElement>('button[aria-label="com.example.app 的操作"]');
    assert.ok(menu);
    await act(async () => {
      menu.focus();
      menu.dispatchEvent(new f.browser.window.KeyboardEvent('keydown', {
        key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true,
      }));
    });
    const menuContent = f.browser.window.document.querySelector<HTMLElement>('[role="menu"]');
    assert.ok(menuContent, '键盘操作应打开真实应用菜单');
    assert.equal(f.resolveOwnedPortalRoot(menuContent)?.anchor === root, true,
      '应用行菜单必须登记到所属插件实例，供调试和生命周期清理');
    assert.equal(menuContent.dataset.deviceforgePlugin, 'deviceforge_device_apps');
    await act(async () => { instance.setVisible(false); });
    assert.equal(f.browser.window.document.querySelector('[role="menu"]'), null);
    assert.equal(f.resolveOwnedPortalRoot(menuContent), null);
    await act(async () => { instance.setVisible(true); });
    await act(async () => { button(root, '安装包分析').click(); });
    const dialog = f.browser.window.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /安装包处理方式|处理方式/);
    const selector = dialog.querySelector<HTMLButtonElement>('button[aria-label="安装包处理方式"]');
    assert.ok(selector);
    assert.equal(selector.textContent, '清单');
    await act(async () => { selector.click(); });
    const options = [...f.browser.window.document.querySelectorAll('[role="option"]')]
      .map((option) => option.textContent);
    assert.deepEqual(options, ['清单', '签名', '提取 APK', 'AAB 构建', '反编译', 'SDK 规则', 'APKS 匹配']);
    await act(async () => { instance.setVisible(false); });
    assert.equal(f.browser.window.document.querySelector('[role="dialog"]'), null);
    assert.equal(f.base.counts.invocations, 1);
    assert.equal(f.base.counts.uploads, 0);
  } finally { await f.dispose(); }
});

test('安装包分析关闭后返回所属入口，多实例保草稿且不自动执行', async () => {
  const f = await fixture(), [first, second] = f.roots;
  assert.ok(first && second);
  try {
    const releaseFirst = await f.mount(first, f.one, f.view('apps.first').instance);
    const other = f.view('apps.second');
    await f.mount(second, f.two, other.instance);
    const otherSearch = search(second);
    await type(otherSearch, 'com.second.draft');
    const opener = button(first, '安装包分析');
    assert.ok(opener.classList.contains('h-[30px]'), '标准触发器不能丢失原分析入口的30px高度');
    assert.ok(opener.classList.contains('text-[13px]'), '标准触发器不能丢失原分析入口的13px字号');
    await act(async () => { opener.focus(); opener.click(); });
    const dialog = f.browser.window.document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    assert.ok(dialog.contains(f.browser.window.document.activeElement));
    assert.ok(f.resolveOwnedPortalRoot(dialog)?.anchor === first);
    assert.equal(opener.getAttribute('aria-expanded'), 'true');
    assert.equal(opener.getAttribute('aria-controls'), dialog.id);
    const label = [...dialog.querySelectorAll('label')].find((entry) => entry.textContent === '安装包产物 ID');
    assert.ok(label?.htmlFor);
    const artifact = f.browser.window.document.getElementById(label.htmlFor);
    assert.ok(artifact instanceof f.browser.window.HTMLInputElement);
    await type(artifact, 'first-artifact-draft');
    await act(async () => {
      f.browser.window.document.activeElement?.dispatchEvent(new f.browser.window.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
    });
    assert.equal(f.browser.window.document.querySelector('[role="dialog"]'), null);
    assert.ok(f.browser.window.document.activeElement === opener, 'Escape应返回所属实例的分析入口');
    assert.equal(opener.getAttribute('aria-expanded'), 'false');
    assert.equal(opener.getAttribute('aria-controls'), null);
    await act(async () => { opener.click(); });
    const reopened = f.browser.window.document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(reopened);
    assert.ok([...reopened.querySelectorAll('input')].some((entry) => entry.value === 'first-artifact-draft'));
    await act(async () => { button(reopened, '关闭').click(); });
    assert.equal(f.browser.window.document.querySelector('[role="dialog"]'), null);
    assert.ok(f.browser.window.document.activeElement === opener, '关闭按钮也应返回原入口');
    const otherOpener = button(second, '安装包分析');
    await act(async () => { otherOpener.focus(); otherOpener.click(); });
    const otherDialog = f.browser.window.document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(otherDialog);
    assert.notEqual(otherDialog.id, reopened.id);
    assert.equal(otherOpener.getAttribute('aria-controls'), otherDialog.id);
    assert.ok(f.resolveOwnedPortalRoot(otherDialog)?.anchor === second);
    assert.equal([...otherDialog.querySelectorAll('input')].some((entry) => entry.value === 'first-artifact-draft'), false);
    const focused = f.browser.window.document.activeElement;
    await act(async () => { await releaseFirst(); });
    assert.equal(otherDialog.isConnected, true);
    assert.ok(f.browser.window.document.activeElement === focused, '卸载另一实例不能夺取当前弹层焦点');
    await act(async () => { button(otherDialog, '关闭').click(); });
    assert.ok(f.browser.window.document.activeElement === otherOpener, '第二实例关闭不能跳回第一实例');
    await act(async () => { otherOpener.click(); });
    const hiddenDialog = f.browser.window.document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(hiddenDialog);
    assert.ok(f.resolveOwnedPortalRoot(hiddenDialog)?.anchor === second);
    await act(async () => { other.setVisible(false); });
    assert.equal(f.browser.window.document.querySelector('[role="dialog"]'), null);
    assert.equal(f.resolveOwnedPortalRoot(hiddenDialog), null);
    assert.equal(search(second), otherSearch);
    assert.equal(otherSearch.value, 'com.second.draft');
    assert.equal(f.base.counts.invocations, 0);
    assert.equal(f.base.counts.uploads, 0);
    assert.equal(f.base.counts.operationReads, 0);
  } finally { await f.dispose(); }
});

test('应用菜单卸载按实例清理，不撤销另一实例的弹层和草稿', async () => {
  const f = await fixture(), [first, second] = f.roots;
  assert.ok(first && second);
  try {
    const releaseFirst = await f.mount(first, f.one, f.view('apps.first').instance);
    const releaseSecond = await f.mount(second, f.two, f.view('apps.second').instance);
    await type(search(second), 'com.example');
    const draft = search(second);
    const read = second.querySelector<HTMLButtonElement>('button[aria-label="读取应用列表"]');
    assert.ok(read);
    await act(async () => { read.click(); });
    const trigger = second.querySelector<HTMLButtonElement>('button[aria-label="com.example.app 的操作"]');
    assert.ok(trigger);
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new f.browser.window.KeyboardEvent('keydown', {
        key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true,
      }));
    });
    const menu = f.browser.window.document.querySelector<HTMLElement>('[role="menu"]');
    assert.ok(menu);
    assert.equal(f.resolveOwnedPortalRoot(menu)?.anchor === second, true);
    await act(async () => { await releaseFirst(); });
    assert.equal(first.querySelector('[data-device-view]'), null);
    assert.equal(menu.isConnected, true);
    assert.equal(f.resolveOwnedPortalRoot(menu)?.anchor === second, true);
    assert.equal(search(second), draft);
    assert.equal(draft.value, 'com.example');
    await act(async () => { await releaseSecond(); });
    assert.equal(menu.isConnected, false);
    assert.equal(f.resolveOwnedPortalRoot(menu), null);
    assert.equal(menu.hasAttribute('data-deviceforge-portal'), false);
    assert.equal(f.base.counts.invocations, 1, '卸载不重放设备应用操作');
    assert.equal(f.base.counts.uploads, 0);
  } finally { await f.dispose(); }
});
