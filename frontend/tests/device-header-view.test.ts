import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import { deviceIdentity } from '../plugins/devices/src/contracts.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type {
  DeviceAccess, DeviceDirectory, DeviceRef, DeviceSnapshot, Dispose, HostContext, ProvidedDevice,
} from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const first: DeviceRef = { providerId: 'first_provider', generation: 'generation-1', localId: 'same-id' };
const second: DeviceRef = { providerId: 'second_provider', generation: 'generation-2', localId: 'same-id' };
function directory(reference: DeviceRef, model: string, state: ProvidedDevice['state']): DeviceDirectory {
  return {
    provider: {
      id: reference.providerId, generation: reference.generation, version: '1.0.0',
      definition: { apiVersion: 3, platform: 'Android',
        discoverOperation: `${reference.providerId}.discover`, capabilities: [] },
    },
    observedAt: 1_798_275_600_000, discoveryJobId: `job-${reference.providerId}`,
    devices: [{ reference, model, state, capabilities: [] }],
  };
}
function deviceFixture() {
  const directories = [
    directory(first, '甲设备', 'online'), directory(second, '乙设备', 'online'),
    directory({ providerId: 'offline_provider', generation: 'generation-3', localId: 'offline-id' }, '离线设备', 'offline'),
    directory({ providerId: 'locked_provider', generation: 'generation-4', localId: 'locked-id' }, '待授权设备', 'unauthorized'),
  ];
  let state: DeviceSnapshot = {
    providers: directories.map((entry) => entry.provider), directories, selection: first,
    selected: directories[0]?.devices[0] ?? null,
  };
  const calls: string[] = [], selections: (DeviceRef | null)[] = [];
  const listeners = new Set<(value: DeviceSnapshot) => void>();
  const notify = () => { for (const listener of [...listeners]) listener(state); };
  const devices: DeviceAccess = {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(reference) {
      selections.push(reference);
      state = {
        ...state, selection: reference,
        selected: state.directories.flatMap((entry) => entry.devices)
          .find((entry) => deviceIdentity(entry.reference) === deviceIdentity(reference)) ?? null,
      };
      notify();
    },
    async refreshProviders(signal) {
      signal.throwIfAborted(); calls.push('providers');
      return { data: state.providers, logId: 'providers-log' };
    },
    async refreshProvider(id, generation, signal) {
      signal.throwIfAborted(); calls.push(`discover:${id}@${generation}`);
      if (id === second.providerId)
        throw new HostError('http', 'discovery_failed', '第二提供者暂时不可达', 'discovery-second-log', 502);
      const found = state.directories.find((entry) => entry.provider.id === id && entry.provider.generation === generation);
      assert.ok(found, '发现只允许访问本次公开目录中的提供者');
      return { data: found, logId: `success-${id}` };
    },
    async refreshDirectories() { calls.push('directories'); throw new Error('菜单不得用旧目录读取替代发现'); },
    async invoke() { calls.push('invoke'); throw new Error('菜单不得自动执行设备动作'); },
  };
  return {
    devices, calls, selections, count: () => listeners.size,
    replaceGeneration(reference: DeviceRef) {
      state = {
        providers: state.providers.map((entry) => entry.id === reference.providerId
          ? { ...entry, generation: reference.generation } : entry),
        directories: state.directories.map((entry) => entry.provider.id === reference.providerId ? {
          ...entry, provider: { ...entry.provider, generation: reference.generation },
          devices: entry.devices.map((device) => ({ ...device, reference })),
        } : entry),
        selection: null, selected: null,
      };
      notify();
    },
  };
}

async function fixture() {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><div id="header"></div><div id="unrelated">其他根内容</div></body></html>',
    { url: 'http://127.0.0.1:7031', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  // 内存 DOM 不提供实际布局；这里只补交互原型，不伪造窗口或元素几何。
  browser.window.HTMLElement.prototype.scrollIntoView = () => {};
  for (const name of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture']) {
    if (!(name in browser.window.HTMLElement.prototype))
      Object.defineProperty(browser.window.HTMLElement.prototype, name,
        { configurable: true, value: name === 'hasPointerCapture' ? () => false : () => {} });
  }
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    NodeFilter: browser.window.NodeFilter, DocumentFragment: browser.window.DocumentFragment,
    HTMLInputElement: browser.window.HTMLInputElement, HTMLButtonElement: browser.window.HTMLButtonElement,
    HTMLSelectElement: browser.window.HTMLSelectElement, HTMLFormElement: browser.window.HTMLFormElement,
    SVGElement: browser.window.SVGElement, CustomEvent: browser.window.CustomEvent,
    PointerEvent: browser.window.PointerEvent, MutationObserver: browser.window.MutationObserver,
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
  const { mountDeviceHeader } = await import('../plugins/devices/src/header.tsx');
  const base = deviceFixture(), lifetime = new AbortController(), releases: Dispose[] = [];
  const forbidden = async (name: string): Promise<never> => {
    base.calls.push(name); throw new Error(`顶栏不得调用 ${name}`);
  };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, devices: base.devices,
    listOperations: () => forbidden('listOperations'), submit: () => forbidden('submit'),
    getJob: () => forbidden('getJob'), cancelJob: () => forbidden('cancelJob'),
    subscribeOperations: () => () => {},
    onDispose(release) { releases.push(release); return release; },
  };
  const root = browser.window.document.getElementById('header');
  assert.ok(root);
  let release: Dispose = () => {};
  await act(async () => { release = mountDeviceHeader(root, context); });
  return {
    base, browser, root,
    async unmount() { await act(async () => { await release(); }); },
    async dispose() {
      try {
        await act(async () => {
          await release(); lifetime.abort();
          for (const resource of releases.reverse()) await resource();
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
type HeaderFixture = Awaited<ReturnType<typeof fixture>>;
function trigger(f: HeaderFixture) {
  const result = f.root.querySelector<HTMLButtonElement>('button[aria-label="选择当前设备"]');
  assert.ok(result);
  return result;
}
function menu(f: HeaderFixture) {
  const result = f.browser.window.document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(result, '真实菜单应已挂载');
  return result;
}
function item(root: ParentNode, role: 'menuitem' | 'menuitemradio', text: string) {
  const result = [...root.querySelectorAll<HTMLElement>(`[role="${role}"]`)]
    .find((entry) => entry.textContent?.includes(text));
  assert.ok(result, `没有找到菜单项：${text}`);
  return result;
}
async function open(f: HeaderFixture, by: 'pointer' | 'keyboard') {
  await act(async () => {
    if (by === 'pointer')
      trigger(f).dispatchEvent(new f.browser.window.PointerEvent('pointerdown',
        { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    else {
      trigger(f).focus();
      trigger(f).dispatchEvent(new f.browser.window.KeyboardEvent('keydown',
        { bubbles: true, cancelable: true, key: 'ArrowDown' }));
    }
  });
  return menu(f);
}

test('真实设备胶囊按状态分组，同序列号跨提供者及换代选择完整引用，显式清除且挂载不发现', async (current) => {
  const errors: string[] = [];
  current.mock.method(console, 'error', (...values: unknown[]) => { errors.push(values.map(String).join(' ')); });
  const f = await fixture();
  try {
    assert.equal(f.root.querySelector('[data-slot="device-context"]')?.contains(trigger(f)), true);
    assert.equal(trigger(f).classList.contains('rounded-full'), true);
    assert.match(trigger(f).textContent ?? '', /甲设备/);
    assert.deepEqual(f.base.calls, []);
    assert.deepEqual(f.base.selections, []);
    const popup = await open(f, 'pointer');
    assert.equal(f.root.contains(popup), false);
    assert.equal(popup.parentElement?.parentElement, f.browser.window.document.body);
    assert.match(popup.textContent ?? '', /4 台 · 2 在线/);
    const groups = [...popup.querySelectorAll<HTMLElement>('[role="group"]')]
      .filter((entry) => entry.querySelector('[role="group"]') === null);
    assert.equal(groups.length, 2);
    assert.match(groups[0]?.textContent ?? '', /^在线.*甲设备.*乙设备/);
    assert.match(groups[1]?.textContent ?? '', /^离线与待授权.*离线设备.*待授权设备/);
    assert.equal(item(popup, 'menuitemradio', '甲设备').getAttribute('aria-checked'), 'true');
    assert.equal(item(popup, 'menuitemradio', '乙设备').getAttribute('aria-checked'), 'false');
    await act(async () => {
      item(popup, 'menuitemradio', '乙设备').dispatchEvent(new f.browser.window.KeyboardEvent('keydown',
        { bubbles: true, cancelable: true, key: 'Enter' }));
    });
    assert.deepEqual(f.base.devices.snapshot().selection, second);
    assert.deepEqual(f.base.selections, [second]);
    assert.match(trigger(f).textContent ?? '', /乙设备/);
    assert.equal(f.browser.window.document.querySelector('[role="menu"]'), null);

    const next: DeviceRef = { ...second, generation: 'generation-next' };
    await act(async () => { f.base.replaceGeneration(next); });
    assert.match(trigger(f).textContent ?? '', /选择设备/);
    const updated = await open(f, 'keyboard');
    await act(async () => { item(updated, 'menuitemradio', '乙设备').click(); });
    assert.deepEqual(f.base.devices.snapshot().selection, next);
    assert.deepEqual(f.base.selections, [second, next]);
    assert.match(trigger(f).textContent ?? '', /乙设备/);
    const clear = await open(f, 'pointer');
    await act(async () => { item(clear, 'menuitem', '清除选择').click(); });
    assert.equal(f.base.devices.snapshot().selection, null);
    assert.deepEqual(f.base.selections, [second, next, null]);
    assert.match(trigger(f).textContent ?? '', /选择设备/);
    assert.deepEqual(f.base.calls, []);
  } finally { await f.dispose(); }
  assert.deepEqual(errors, [], '真实组件交互不应产生 React 或 DOM 错误');
});

test('真实菜单只有显式点击才发现，部分失败展示关联日志，根卸载撤销 body 弹层和设备订阅', async (current) => {
  const errors: string[] = [];
  current.mock.method(console, 'error', (...values: unknown[]) => { errors.push(values.map(String).join(' ')); });
  const f = await fixture();
  try {
    const popup = await open(f, 'keyboard');
    assert.deepEqual(f.base.calls, [], '挂载及打开菜单均不能自动发起发现');
    assert.equal(f.base.count(), 1);
    const discover = item(popup, 'menuitem', '发现设备');
    assert.notEqual(discover.getAttribute('aria-disabled'), 'true');
    await act(async () => {
      discover.click();
      for (let index = 0; index < 40; index++) await Promise.resolve();
    });
    assert.deepEqual(f.base.calls, [
      'providers', ...f.base.devices.snapshot().providers.map((entry) => `discover:${entry.id}@${entry.generation}`),
    ]);
    const alert = menu(f).querySelector('[role="alert"]');
    assert.ok(alert, '单个提供者失败仍需可见反馈');
    assert.match(alert.textContent ?? '', /已刷新 3 个提供者，1 个发现失败/);
    assert.match(alert.textContent ?? '', /第二提供者暂时不可达/);
    assert.match(alert.textContent ?? '', /日志 discovery-second-log/);
    assert.match(alert.textContent ?? '', /second_provider/);
    assert.equal(f.root.contains(menu(f)), false);
    await f.unmount();
    assert.equal(f.root.childElementCount, 0);
    assert.equal(f.browser.window.document.querySelector('[role="menu"]'), null);
    assert.equal(f.browser.window.document.querySelector('[data-slot="dropdown-menu-content"]'), null);
    assert.equal(f.browser.window.document.querySelector('[data-radix-popper-content-wrapper]'), null);
    assert.equal(f.browser.window.document.querySelector('[data-radix-focus-guard]'), null);
    assert.equal(f.base.count(), 0);
    assert.equal(f.browser.window.document.getElementById('unrelated')?.textContent, '其他根内容');
    assert.equal(f.base.calls.some((entry) => ['submit', 'invoke', 'cancelJob'].includes(entry)), false);
  } finally { await f.dispose(); }
  assert.deepEqual(errors, [], '显式发现和卸载不应产生 React 或 DOM 错误');
});
