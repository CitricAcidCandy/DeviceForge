import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { HostError } from '../src/plugin-sdk/index.ts';
import type {
  DeviceAccess, DeviceDirectory, DeviceProviderInfo, DeviceRef, DeviceSnapshot, Dispose, HostContext, Operation,
} from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const first: DeviceRef = { providerId: 'unit_android', generation: 'android-7', localId: 'shared-local-id' };
const second: DeviceRef = { providerId: 'unit_external', generation: 'external-9', localId: 'shared-local-id' };
const android: DeviceProviderInfo = {
  id: first.providerId, generation: first.generation, version: '1.0.0',
  definition: { apiVersion: 3, platform: 'Android', discoverOperation: 'unit_android.discover',
    capabilities: [{ id: 'inspect', version: 1, operation: 'unit_android.inspect', scope: 'device', access: 'read' }] },
};
const external: DeviceProviderInfo = {
  id: second.providerId, generation: second.generation, version: '1.0.0',
  definition: { apiVersion: 3, platform: '测试平台', discoverOperation: 'unit_external.discover',
    capabilities: [{ id: 'inspect', version: 1, operation: 'unit_external.inspect', scope: 'device', access: 'read' }] },
};
const directories: readonly DeviceDirectory[] = [
  { provider: android, observedAt: 1000, discoveryJobId: 'android-history', devices: [
    { reference: first, model: '设备甲', state: 'online', capabilities: [{ id: 'inspect', version: 1, available: true, reason: null }] },
    { reference: { ...first, localId: 'offline-id' }, model: '离线设备', state: 'offline', capabilities: [] },
  ] },
  { provider: external, observedAt: 2000, discoveryJobId: 'external-history', devices: [
    { reference: second, model: '设备乙', state: 'online', capabilities: [{ id: 'inspect', version: 1, available: true, reason: null }] },
  ] },
];
const operations: readonly Operation[] = [
  { id: 'unit_android.inspect', title: '读取安卓设备信息', input_schema: {} },
  { id: 'unit_external.inspect', title: '读取外部设备信息', input_schema: {} },
];

async function fixture(failingProvider?: string) {
  const imports = registerCompositionStartupImports();
  const browser = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:7031', pretendToBeVisual: true,
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    HTMLInputElement: browser.window.HTMLInputElement, HTMLButtonElement: browser.window.HTMLButtonElement,
    HTMLSelectElement: browser.window.HTMLSelectElement, HTMLFormElement: browser.window.HTMLFormElement,
    DocumentFragment: browser.window.DocumentFragment, NodeFilter: browser.window.NodeFilter,
    MutationObserver: browser.window.MutationObserver, CustomEvent: browser.window.CustomEvent,
    getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
    requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
    cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const { hostUi } = await import('../src/plugin-sdk/index.ts');
  const removeUi = installPublicUi();
  const { DeviceDirectory } = await import('../plugins/devices/src/view.tsx');
  const { createDeviceDirectory } = await import('../plugins/devices/src/directory.ts');
  const lifetime = new AbortController(), listeners = new Set<(snapshot: DeviceSnapshot) => void>();
  const operationListeners = new Set<(value: readonly Operation[]) => void>();
  const calls: string[] = [], selected: (DeviceRef | null)[] = [];
  let state: DeviceSnapshot = { providers: [android, external], directories, selection: null, selected: null };
  let closed = 0, connected = 0;
  const devices: DeviceAccess = {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(reference) {
      calls.push('select'); selected.push(reference);
      state = { ...state, selection: reference,
        selected: directories.flatMap((entry) => entry.devices).find((entry) => reference
          && entry.reference.providerId === reference.providerId && entry.reference.generation === reference.generation
          && entry.reference.localId === reference.localId) ?? null };
      for (const listener of listeners) listener(state);
    },
    refreshProviders: async () => { calls.push('providers'); return { data: state.providers, logId: 'providers-log' }; },
    refreshDirectories: async () => { calls.push('directories'); return { data: state.directories, logId: 'directories-log' }; },
    refreshProvider: async (id, generation) => {
      calls.push(`discover:${id}:${generation}`);
      if (id === failingProvider) throw new HostError('http', 'device_discovery_failed', '发现测试平台失败', 'failed-provider-log', 502);
      const directory = directories.find((entry) => entry.provider.id === id && entry.provider.generation === generation);
      assert.ok(directory);
      return { data: directory, logId: `${id}-discovery-log` };
    },
    invoke: async () => { calls.push('invoke'); throw new Error('目录还原单元不能调用设备能力'); },
  };
  const forbidden = async (): Promise<never> => { throw new Error('目录单元不能提交或查询真实任务'); };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, devices, listOperations: async () => ({ data: operations, logId: null }),
    subscribeOperations(listener) { operationListeners.add(listener); return () => { operationListeners.delete(listener); }; },
    submit: forbidden, getJob: forbidden, cancelJob: forbidden, onDispose: (release) => release,
  };
  const model = createDeviceDirectory(context), root = browser.window.document.getElementById('root');
  assert.ok(root);
  let releaseRoot: Dispose = () => {};
  await act(async () => {
    const props = { context, model, onClose: () => { closed++; }, onConnect: () => { connected++; } };
    releaseRoot = hostUi().mountReact(root, createElement(DeviceDirectory, props));
  });
  const button = (name: string | RegExp, within: ParentNode = root) => {
    const match = [...within.querySelectorAll<HTMLButtonElement>('button')].find((element) => {
      const label = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
      return typeof name === 'string' ? label === name : name.test(label);
    });
    assert.ok(match, `缺少按钮：${name}`);
    return match;
  };
  return {
    root, model, calls, selected, button, closed: () => closed, connected: () => connected,
    async click(name: string | RegExp, within?: ParentNode) { await act(async () => { button(name, within).click(); }); },
    async search(value: string) {
      const input = root.querySelector<HTMLInputElement>('input[aria-label="搜索设备"]');
      assert.ok(input, '缺少设备搜索输入框');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(browser.window.HTMLInputElement.prototype, 'value')?.set;
        assert.ok(setter); setter.call(input, value);
        input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
      });
    },
    async dispose() {
      try {
        await act(async () => { await releaseRoot(); await model.dispose(); lifetime.abort(); });
        assert.equal(listeners.size, 0, '退出设备目录必须释放设备订阅');
        assert.equal(operationListeners.size, 0, '退出设备目录必须释放公开操作订阅');
      } finally {
        await removeUi(); imports.dispose(); browser.window.close();
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}

test('目录恢复全页选择设备与原头部操作，挂载不自动发现、读取目录或选择', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.calls, []);
    const page = f.root.querySelector('section[aria-label="选择设备"]');
    assert.ok(page, '应恢复全页选择设备，不嵌套简化目录卡片');
    assert.equal(page.querySelector('h1')?.textContent, '选择设备');
    for (const name of ['退出设备选择', '读取目录', '发现设备', '连接地址']) f.button(name, page);
    assert.ok(page.querySelector('aside[aria-label="当前选择"]'));
    assert.match(page.textContent ?? '', /设备提供者/);
    assert.equal(f.root.querySelector('[role="radiogroup"]'), null, '原设备目录使用完整选择卡片');
  } finally { await f.dispose(); }
});

test('目录搜索名称与来源过滤保留在线、离线分组，过滤不会提交设备调用', async () => {
  const f = await fixture();
  try {
    const list = f.root.querySelector('[aria-label="已发现设备"]');
    assert.ok(list);
    const headings = [...list.querySelectorAll('h2')].map((element) => element.textContent ?? '');
    assert.match(headings[0] ?? '', /在线/);
    assert.match(headings[1] ?? '', /离线与待授权/);
    assert.equal(list.querySelectorAll('button[aria-label^="选择设备 "]').length, 3);
    await f.search('设备乙');
    assert.equal(list.querySelectorAll('button[aria-label^="选择设备 "]').length, 1);
    assert.match(list.textContent ?? '', /设备乙/);
    assert.doesNotMatch(list.textContent ?? '', /设备甲|离线设备/);
    await f.search('');
    const sources = f.root.querySelector('[role="group"][aria-label="设备来源"]');
    assert.ok(sources);
    await f.click(/^测试平台/, sources);
    assert.equal(list.querySelectorAll('button[aria-label^="选择设备 "]').length, 1);
    assert.equal(f.button(/^测试平台/, sources).getAttribute('aria-pressed'), 'true');
    await f.click(/^全部/, sources);
    assert.equal(list.querySelectorAll('button[aria-label^="选择设备 "]').length, 3);
    assert.deepEqual(f.calls, []);
  } finally { await f.dispose(); }
});

test('完整设备目录的窄容器头部允许标题独占一行及操作换行，不压成竖排文字', async () => {
  const f = await fixture();
  try {
    const header = f.root.querySelector('header');
    assert.ok(header);
    const title = header.firstElementChild;
    const actions = header.lastElementChild;
    assert.ok(title && actions && title !== actions);
    assert.ok(header.classList.contains('@max-[600px]/directory:flex-wrap'));
    assert.ok(title.classList.contains('@max-[600px]/directory:basis-full'));
    assert.ok(actions.classList.contains('flex-wrap'));
    assert.deepEqual(f.calls, []);
  } finally { await f.dispose(); }
});

test('窄容器目录单列按内容保留每行高度，由外层滚动而非重叠设备卡', async () => {
  const f = await fixture();
  try {
    const list = f.root.querySelector('[aria-label="已发现设备"]');
    assert.ok(list?.parentElement);
    const content = list.parentElement;
    assert.ok(content.classList.contains('@max-[900px]/directory:auto-rows-max'));
    assert.ok(content.classList.contains('@max-[900px]/directory:content-start'));
    assert.ok(content.classList.contains('@max-[900px]/directory:overflow-y-auto'));
    assert.deepEqual(f.calls, []);
  } finally { await f.dispose(); }
});

test('目录卡片提交完整提供者与代次引用，右栏同步当前设备及中文能力名称', async () => {
  const f = await fixture();
  try {
    await f.click(/^选择设备 设备乙，测试平台，shared-local-id$/);
    assert.deepEqual(f.selected, [second], '相同本地标识不能误选另一提供者');
    assert.deepEqual(f.calls, ['select']);
    assert.equal(f.button(/^选择设备 设备乙，/).getAttribute('aria-pressed'), 'true');
    assert.equal(f.button(/^选择设备 设备甲，/).getAttribute('aria-pressed'), 'false');
    const aside = f.root.querySelector('aside[aria-label="当前选择"]');
    assert.ok(aside);
    for (const value of ['设备乙', second.providerId, second.localId, '读取外部设备信息'])
      assert.ok(aside.textContent?.includes(value), `右侧详情缺少：${value}`);
  } finally { await f.dispose(); }
});

test('目录返回和连接地址只调用所属工作台回调，不隐式清除选择或连接设备', async () => {
  const f = await fixture();
  try {
    await f.click('退出设备选择');
    await f.click('连接地址');
    assert.equal(f.closed(), 1);
    assert.equal(f.connected(), 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.selected, []);
  } finally { await f.dispose(); }
});

test('目录全部发现只由显式点击触发，单提供者失败保留日志且聚合刷新不重复读提供者', async () => {
  const f = await fixture(android.id);
  try {
    assert.deepEqual(f.calls, []);
    await f.click('发现设备', f.root.querySelector('header') ?? undefined);
    assert.deepEqual(f.calls, ['providers', `discover:${android.id}:${android.generation}`,
      `discover:${external.id}:${external.generation}`]);
    assert.equal(f.model.snapshot().feedback?.outcome, 'partial');
    assert.match(f.root.textContent ?? '', /发现测试平台失败/);
    assert.match(f.root.textContent ?? '', /failed-provider-log/);
    assert.deepEqual(f.selected, []);
    f.calls.length = 0;
    await f.click('读取目录');
    assert.deepEqual(f.calls, ['directories'], '公开聚合目录入口已包含提供者读取');
  } finally { await f.dispose(); }
});
