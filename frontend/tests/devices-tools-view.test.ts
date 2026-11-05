import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement, StrictMode } from 'react';
import { JSDOM } from 'jsdom';
import type { DeviceAction, DeviceCapability, DeviceDirectory, DeviceProviderInfo, DeviceSnapshot, Dispose,
  HostContext, HostResult, Job, Operation } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { deferred } from './fixtures.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';

const browser = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser.window, document: browser.window.document,
  navigator: browser.window.navigator, HTMLElement: browser.window.HTMLElement, Element: browser.window.Element,
  MutationObserver: browser.window.MutationObserver, Event: browser.window.Event, IS_REACT_ACT_ENVIRONMENT: true })) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
Object.defineProperty(browser.window.HTMLDialogElement.prototype, 'showModal', { configurable: true,
  value(this: HTMLDialogElement) { this.open = true; } });
Object.defineProperty(browser.window.HTMLDialogElement.prototype, 'close', { configurable: true,
  value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new browser.window.Event('close')); } });
const imports = registerCompositionStartupImports();
const { createRoot } = await import('react-dom/client');
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { WorkbenchTools } = await import('../plugins/devices/src/workbench-tools.tsx');
const { WorkbenchDialog } = await import('../plugins/devices/src/workbench-dialog.tsx');
const { DeviceWorkbench } = await import('../plugins/devices/src/workbench.tsx');
const { createWorkbenchChildren } = await import('../plugins/devices/src/workbench-children.ts');
imports.dispose();
const publicUi = installPublicUi();
after(async () => {
  await publicUi(); browser.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

const reference = { providerId: 'custom', generation: 'one', localId: 'same' };
const connect: DeviceCapability = { id: 'connect', version: 1, scope: 'provider', access: 'write', operation: 'custom.connect' };
const disconnect: DeviceCapability = { id: 'disconnect', version: 1, scope: 'provider', access: 'write', operation: 'custom.disconnect' };
const read: DeviceCapability = { id: 'probe', version: 2, scope: 'device', access: 'read', operation: 'custom.probe' };
const provider: DeviceProviderInfo = { id: reference.providerId, generation: reference.generation, version: '1',
  definition: { apiVersion: 3, platform: '测试提供者', discoverOperation: 'custom.discover', capabilities: [connect, disconnect, read] } };
function success(action: DeviceAction): HostResult<Job> {
  return { data: { id: `job-${action.capability}`, operation: `custom.${action.capability}`, status: 'succeeded',
    result: { result: { observed: action.input }, artifacts: [] }, error: null }, logId: `log-${action.capability}` };
}
function fixture() {
  const owner = new AbortController(), listeners = new Set<(value: DeviceSnapshot) => void>();
  const operationListeners = new Set<(value: readonly Operation[]) => void>();
  const device = { reference, model: '测试设备', state: 'online' as const, rawState: 'Vendor.Normal',
    capabilities: [{ id: 'probe', version: 2, available: true, reason: null }] };
  const directory: DeviceDirectory = { provider, observedAt: 1, discoveryJobId: 'discovery', devices: [device] };
  let snapshot: DeviceSnapshot = { providers: [provider], directories: [directory], selection: reference, selected: device };
  const operations: readonly Operation[] = [connect, disconnect, read].map((entry) => ({
    id: entry.operation, title: entry.id === 'probe' ? '读取原始探针' : entry.id, input_schema: { type: 'object', properties: { input: {
      type: 'object', properties: entry.scope === 'provider' ? { address: { type: 'string' } } : {},
      required: entry.scope === 'provider' ? ['address'] : [],
    } } },
  }));
  const calls = { operations: 0, discover: 0, invoke: [] as DeviceAction[], get: 0, cancel: 0 };
  const implementation = {
    invoke: async (action: DeviceAction, _signal: AbortSignal): Promise<HostResult<Job>> => success(action),
    getJob: async (_id: string, _signal: AbortSignal): Promise<HostResult<Job>> => success({ providerId: 'custom', generation: 'one', deviceId: null, capability: 'connect', version: 1, input: {} }),
    discover: async (_signal: AbortSignal): Promise<HostResult<DeviceDirectory>> => ({ data: directory, logId: 'directory-log' }),
  };
  const unavailable = async (): Promise<never> => { throw new Error('界面单元不得访问真实设备或其他业务'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, submit: unavailable, onDispose: (release) => release,
    listOperations: async () => { calls.operations++; return { data: operations, logId: 'operations-log' }; },
    subscribeOperations: (listener) => { operationListeners.add(listener); return () => { operationListeners.delete(listener); }; },
    getJob: (id, signal) => { calls.get++; return implementation.getJob(id, signal); },
    cancelJob: async () => { calls.cancel++; throw new Error('页面不应自动取消后台任务'); },
    devices: {
      snapshot: () => ({ ...snapshot }),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      select: () => { throw new Error('表单不得自动改选设备'); },
      refreshProviders: unavailable, refreshDirectories: unavailable,
      refreshProvider: (_id, _generation, signal) => { calls.discover++; return implementation.discover(signal); },
      invoke: (action, signal) => { calls.invoke.push(action); return implementation.invoke(action, signal); },
    },
  };
  const target = browser.window.document.createElement('div'); browser.window.document.body.append(target);
  const root = createRoot(target);
  return { context, calls, implementation, root, target, owner,
    async render(kind: 'connection' | 'capabilities', strict = false) {
      const element = createElement(WorkbenchTools, { kind, context, provider, reference });
      await act(async () => { root.render(strict ? createElement(StrictMode, null, element) : element); });
    },
    replaceDevices(value: DeviceSnapshot) { snapshot = value; for (const listener of [...listeners]) listener(snapshot); },
    async close() {
      await act(async () => { root.unmount(); owner.abort(); });
      assert.equal(listeners.size, 0); assert.equal(operationListeners.size, 0); target.remove();
    },
  };
}
function button(target: ParentNode, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label);
  assert.ok(found, `缺少按钮：${label}`); return found;
}
async function fill(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = input instanceof browser.window.HTMLInputElement ? browser.window.HTMLInputElement.prototype : browser.window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; assert.ok(setter);
  await act(async () => { setter.call(input, text); input.dispatchEvent(new browser.window.Event('input', { bubbles: true })); });
}

test('连接表单恢复真实连接与断开确认，打开只读能力目录且完成才重新发现', async () => {
  const f = fixture();
  try {
    await f.render('connection', true);
    assert.ok(f.target.querySelector('[data-product-section="devices-connect"]'));
    assert.ok(f.calls.operations > 0); assert.equal(f.calls.invoke.length, 0); assert.equal(f.calls.discover, 0);
    const address = f.target.querySelector<HTMLInputElement>('input[aria-label="设备连接地址"]');
    assert.ok(address); await fill(address, 'my-host:1234');
    await act(async () => button(f.target, '连接地址').click());
    assert.equal(f.calls.invoke.length, 1);
    assert.deepEqual(f.calls.invoke[0], { providerId: 'custom', generation: 'one', deviceId: null, capability: 'connect', version: 1, input: { address: 'my-host:1234' } });
    assert.equal(f.calls.discover, 1); assert.match(f.target.textContent ?? '', /任务已完成/);
    await act(async () => button(f.target, '断开地址').click());
    assert.equal(f.calls.invoke.length, 1, '断开确认前不得执行设备写入');
    assert.equal(f.target.querySelector('dialog')?.open, true);
    await act(async () => button(f.target, '保持连接').click());
    assert.equal(f.calls.invoke.length, 1); assert.equal(f.target.querySelector('dialog')?.open, false);
    await act(async () => button(f.target, '断开地址').click());
    await act(async () => button(f.target, '确认断开').click());
    assert.equal(f.calls.invoke[1]?.capability, 'disconnect'); assert.equal(f.calls.discover, 2);
    assert.equal(f.calls.cancel, 0);
  } finally { await f.close(); }
});

test('连接任务成功但目录失败单独提示，不重放连接也不抹掉任务日志', async () => {
  const f = fixture();
  f.implementation.discover = async () => { throw Object.assign(new Error('发现失败，请重新读取'), { logId: 'discovery-failed-log' }); };
  try {
    await f.render('connection');
    const input = f.target.querySelector<HTMLInputElement>('input'); assert.ok(input);
    await fill(input, 'host:1234');
    await act(async () => button(f.target, '连接地址').click());
    assert.match(f.target.textContent ?? '', /任务已完成/);
    assert.match(f.target.textContent ?? '', /发现失败/);
    assert.match(f.target.textContent ?? '', /discovery-failed-log/);
    assert.match(f.target.textContent ?? '', /log-connect/);
    assert.equal(f.calls.invoke.length, 1);
    await act(async () => button(f.target, '重新发现并更新目录').click());
    assert.equal(f.calls.discover, 2); assert.equal(f.calls.invoke.length, 1);
  } finally { await f.close(); }
});

test('能力抽屉恢复完整事实与原始输入输出，不支持或输入错误不派发请求', async () => {
  const f = fixture();
  try {
    await f.render('capabilities', true);
    assert.ok(f.target.querySelector('[data-product-section="device-capabilities"]'));
    assert.match(f.target.textContent ?? '', /Vendor.Normal/); assert.match(f.target.textContent ?? '', /高级能力操作/);
    assert.equal(f.calls.invoke.length, 0);
    const input = f.target.querySelector<HTMLTextAreaElement>('textarea[aria-label="probe@2 业务输入"]');
    assert.ok(input);
    await fill(input, '[]');
    await act(async () => button(f.target, '执行读取任务').click());
    assert.equal(f.calls.invoke.length, 0); assert.match(f.target.textContent ?? '', /JSON 对象/);
    await fill(input, '{"argument":"原始业务"}');
    await act(async () => button(f.target, '执行读取任务').click());
    assert.equal(f.calls.invoke.length, 1);
    assert.deepEqual(f.calls.invoke[0], { providerId: 'custom', generation: 'one', deviceId: 'same', capability: 'probe', version: 2, input: { argument: '原始业务' } });
    assert.match(f.target.textContent ?? '', /原始业务/); assert.match(f.target.textContent ?? '', /log-probe/);
    const devices = f.context.devices?.snapshot(); assert.ok(devices?.selected);
    const selected = devices.selected;
    await act(async () => f.replaceDevices({ ...devices, selected: { ...selected, state: 'offline' } }));
    assert.equal(button(f.target, '执行读取任务').disabled, true);
    assert.equal(input.value, '{"argument":"原始业务"}');
  } finally { await f.close(); }
});

test('停止等待后的查询只读原任务，不重提连接且不自动发起发现', async () => {
  const f = fixture(), late = deferred<HostResult<Job>>();
  f.implementation.invoke = async (action) => ({ ...success(action), data: { ...success(action).data, status: 'queued' } });
  f.implementation.getJob = async () => late.promise;
  try {
    await f.render('connection');
    const input = f.target.querySelector<HTMLInputElement>('input'); assert.ok(input); await fill(input, 'host:1234');
    await act(async () => button(f.target, '连接地址').click());
    await act(async () => button(f.target, '停止页面等待').click());
    assert.match(f.target.textContent ?? '', /结果尚未确认/);
    assert.equal(f.calls.invoke.length, 1); assert.equal(f.calls.discover, 0);
    f.implementation.getJob = async () => success({ providerId: 'custom', generation: 'one', deviceId: null, capability: 'connect', version: 1, input: {} });
    await act(async () => button(f.target, '查询任务结果').click());
    assert.match(f.target.textContent ?? '', /已查询到任务完成/);
    assert.equal(f.calls.invoke.length, 1); assert.equal(f.calls.discover, 0); assert.equal(f.calls.cancel, 0);
    late.resolve(success({ providerId: 'custom', generation: 'one', deviceId: null, capability: 'connect', version: 1, input: {} }));
  } finally { await f.close(); }
});

test('受控目录切到连接弹窗时旧close事件不误关新面，抽屉只用Tailwind尺寸', async () => {
  const f = fixture();
  const changes: boolean[] = [];
  const props = { title: '设备目录', description: '目录', onOpenChange: (open: boolean) => changes.push(open) };
  try {
    await act(async () => { f.root.render(createElement(WorkbenchDialog, { ...props, open: true, children: '原目录' })); });
    assert.equal(f.target.querySelector('dialog')?.open, true);
    await act(async () => { f.root.render(createElement(WorkbenchDialog, { ...props, open: false, children: '原目录' })); });
    assert.deepEqual(changes, []);
    await act(async () => { f.root.render(createElement(WorkbenchDialog, { ...props, open: true, side: 'right', children: '能力' })); });
    const dialog = f.target.querySelector('dialog'); assert.ok(dialog);
    assert.ok(dialog.classList.contains('w-[min(560px,100vw)]'));
    assert.ok(dialog.classList.contains('max-h-dvh'));
    await act(async () => { dialog.dispatchEvent(new browser.window.Event('cancel')); });
    assert.deepEqual(changes, [false]);
  } finally { await f.close(); }
});

test('无设备工作台直接使用连续舞台，保留单份工具条和明确入口而不添加全屏白卡', async () => {
  const f = fixture(), registry = createWorkspaceRegistry();
  const access = registry.access({ pluginId: 'deviceforge_devices', generation: 1, signal: f.owner.signal });
  let mounted = 0;
  const ui = { ...access, mount: async () => { mounted++; return () => {}; } };
  const context: HostContext = { ...f.context, ui };
  access.register({ workspaces: [{ id: 'deviceforge_devices.workspace', title: '设备' }], views: [{
    id: 'deviceforge_devices.workbench', title: '设备工作台', mount: async () => () => {},
  }] });
  access.open({ instanceId: 'deviceforge_devices.workbench.main', workspaceId: 'deviceforge_devices.workspace',
    provider: { pluginId: 'deviceforge_devices', viewId: 'deviceforge_devices.workbench' },
    target: { kind: 'device', reference: null }, visible: true });
  const resolved = registry.resolveView('deviceforge_devices.workbench.main'); assert.ok(resolved);
  const children = createWorkbenchChildren(context, resolved.instance);
  try {
    f.replaceDevices({ providers: [], directories: [], selected: null, selection: null });
    await act(async () => { f.root.render(createElement(DeviceWorkbench, { context, instance: resolved.instance, children })); });
    const stage = f.target.querySelector('[data-product-page="devices"]'); assert.ok(stage);
    assert.equal(stage.querySelectorAll('nav[aria-label="设备工具"]').length, 1);
    const status = [...stage.querySelectorAll('h1')].find((entry) => entry.textContent === '设备目录尚未确认');
    assert.ok(status);
    const wrapper = status.closest('section')?.querySelector(':scope > div'); assert.ok(wrapper);
    assert.equal(wrapper.classList.contains('bg-white'), false, '空态不能另造白色工作区外壳');
    assert.equal(wrapper.classList.contains('rounded-2xl'), false);
    assert.equal(wrapper.classList.contains('border'), false);
    assert.equal(wrapper.classList.contains('mx-16'), false);
    assert.ok(wrapper.classList.contains('flex-1'));
    assert.ok(wrapper.classList.contains('min-h-0'));
    assert.ok(button(stage, '打开设备目录'));
    assert.doesNotMatch(stage.textContent ?? '', /还没有可用的设备提供者/,
      '旧宿主未提供读取事实时不能凭空数组报没有提供者；真空目录的市场入口由真实读取单元覆盖');
    assert.ok(button(stage, '连接设备'));
    assert.equal(f.calls.invoke.length, 0); assert.equal(f.calls.discover, 0); assert.equal(mounted, 0);
  } finally { children.dispose(); await f.close(); registry.dispose(); }
});
