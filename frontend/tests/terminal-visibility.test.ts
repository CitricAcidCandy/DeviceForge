import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose, HostContext, HostResult, JsonValue, WorkspaceViewContext } from '../src/plugin-sdk/index.ts';
import type { SessionInfo } from '../plugins/terminal/src/model/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const page = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031/#/terminal', pretendToBeVisual: true,
});
const document = page.window.document;
const previous = new Map<string, PropertyDescriptor | undefined>();
const observers = new Set<() => void>();
class SizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) { this.callback = callback; observers.add(callback); }
  observe() {} unobserve() {} disconnect() { observers.delete(this.callback); }
}
for (const [name, value] of Object.entries({
  window: page.window, document, navigator: page.window.navigator,
  Element: page.window.Element, HTMLElement: page.window.HTMLElement, Document: page.window.Document,
  HTMLInputElement: page.window.HTMLInputElement, HTMLButtonElement: page.window.HTMLButtonElement,
  HTMLTextAreaElement: page.window.HTMLTextAreaElement, HTMLFormElement: page.window.HTMLFormElement,
  DocumentFragment: page.window.DocumentFragment, Node: page.window.Node, NodeFilter: page.window.NodeFilter,
  MutationObserver: page.window.MutationObserver, Event: page.window.Event, CustomEvent: page.window.CustomEvent,
  ResizeObserver: SizeObserver, getComputedStyle: page.window.getComputedStyle.bind(page.window),
  requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
  cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const imports = registerCompositionStartupImports();
// 仅替换内存DOM无法排字的xterm依赖，保留真实TerminalPage、视口effect和会话模型。
const emulator = registerHooks({
  resolve(specifier, context, next) {
    const name = specifier === '@xterm/xterm' ? 'terminal' : specifier === '@xterm/addon-fit' ? 'fit' : null;
    return name ? { url: `terminal-visibility-unit:${name}`, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'terminal-visibility-unit:terminal') return { format: 'module', shortCircuit: true, source: `
      export class Terminal {
        constructor(options) { this.options = options; this.cols = options.cols; this.rows = options.rows; }
        loadAddon(addon) { addon.activate(this); }
        open(node) { this.textarea = document.createElement('textarea'); node.append(this.textarea); }
        onData() { return { dispose() {} }; } attachCustomKeyEventHandler() {}
        resize(cols, rows) { this.cols = cols; this.rows = rows; } focus() {} write() {}
        dispose() { this.textarea?.remove(); }
      }` };
    if (url === 'terminal-visibility-unit:fit') return { format: 'module', shortCircuit: true, source: `
      export class FitAddon { activate() {} proposeDimensions() { return { cols: 120, rows: 30 }; } }` };
    return next(url, context);
  },
});
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const releaseUi = installPublicUi();
const { TerminalPage } = await import('../plugins/terminal/src/view.tsx');
const { createTerminalServices } = await import('../plugins/terminal/src/services.ts');
after(async () => {
  await act(async () => {}); await new Promise<void>((resolve) => setImmediate(resolve));
  emulator.deregister(); await releaseUi(); imports.dispose(); page.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

async function settle() { await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }); }
function reader(root: HTMLElement) {
  const button = root.querySelector<HTMLButtonElement>('button[aria-label$="读取输出"]');
  assert.ok(button, '真实终端应保留原输出读取操作'); return button;
}
async function fixture(failSnapshot = false) {
  const owner = new AbortController(), listeners = new Set<(visible: boolean) => void>();
  const signals: AbortSignal[] = [], reads: string[] = [];
  let writes = 0, visible = true, subscribed = false, released = false;
  const expected = new Error('可见性快照读取失败');
  const id = '12345678-1234-1234-1234-123456789abc';
  const session = { id, operation: 'plugin.terminal.open', plugin_id: 'terminal',
    generation: 'g1', created_at: 1, status: 'running', output_sequence: 0, completion: null } satisfies SessionInfo;
  const forbidden = async (): Promise<never> => { writes++; throw new Error('可见性单元禁止新会话、命令和设备调用'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, submit: forbidden, getJob: forbidden, cancelJob: forbidden,
    listOperations: async () => ({ data: [], logId: null }), subscribeOperations: () => () => {},
    onDispose: (release) => release, onCleanup: () => () => {},
    transport: {
      bytes: forbidden, stream: forbidden,
      async request(request, signal): Promise<HostResult<JsonValue>> {
        if (request.method && request.method !== 'GET') return forbidden();
        reads.push(request.path);
        if (request.path.includes('/output?')) {
          signals.push(signal);
          return new Promise<HostResult<JsonValue>>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        if (request.path === `/api/v2/sessions/${id}`) return { data: { ...session }, logId: 'observe-session' };
        if (request.path === '/api/v2/sessions') return { data: [], logId: 'observe-records' };
        if (request.path === '/api/v2/session-definitions') return { data: { revision: 1, sessions: [{
          id: 'plugin.terminal.open', title: '终端', input_schema: { type: 'object' },
          execution: { api_version: 1, source: 'declared', total_timeout_ms: 60000 },
        }] }, logId: 'observe-definitions' };
        if (request.path === '/api/v2/plugin-configurations/server/terminal') return { data: {
          kind: 'server', id: 'terminal', values: { profiles: { local: { executable: 'fixture-only' } } },
        }, logId: 'observe-profiles' };
        throw new Error(`未预期只读请求：${request.path}`);
      },
    },
  };
  const services = createTerminalServices(context);
  // 只读取已有内存会话，输入状态保持unknown；挂载和可见性切换都不打开或接回输入。
  await services.sessions.resume(id, owner.signal);
  const instance: WorkspaceViewContext = {
    signal: owner.signal,
    snapshot() {
      if (failSnapshot && subscribed) throw expected;
      return { instanceId: 'visibility.terminal', workspaceId: 'terminal', pluginId: 'deviceforge_terminal',
        providerGeneration: 1, generation: 1, provider: { pluginId: 'deviceforge_terminal', viewId: 'main' },
        target: null, visible, state: 'ready', reason: null };
    },
    subscribeVisibility(listener) {
      visible = false; subscribed = true;
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  };
  const root = document.createElement('main'); document.body.append(root);
  let release: Dispose = () => {};
  return {
    root, services, instance, expected, signals, reads, writes: () => writes, listeners,
    async mount() { await act(async () => { release = hostUi().mountReact(root, createElement(TerminalPage, { services, instance })); }); },
    async setVisible(value: boolean) { await act(async () => { visible = value; for (const listener of listeners) listener(value); }); },
    async release() { if (!released) { await act(async () => { await release(); }); released = true; } },
    async dispose() {
      try { if (!released) await act(async () => { await release(); }); }
      finally { owner.abort(); await services.dispose(); root.remove(); }
    },
  };
}

test('终端可见性在首次读取与订阅间变化后消费最新快照，隐藏显示不重建原输入或发送命令', async () => {
  const f = await fixture();
  try {
    await f.mount(); await settle();
    const input = f.root.querySelector<HTMLTextAreaElement>('textarea[aria-label="终端输入"]');
    assert.ok(input, '真实终端视口应已创建所属输入节点');
    input.value = '仍在编辑的输入草稿';
    assert.equal(reader(f.root).getAttribute('aria-label'), '继续读取输出',
      '订阅前变为隐藏时，不能继续按首次可见状态读取输出');
    assert.equal(f.signals.every((signal) => signal.aborted), true);
    assert.equal(f.listeners.size, 1);
    await f.setVisible(true); await settle();
    assert.equal(reader(f.root).getAttribute('aria-label'), '暂停读取输出');
    assert.ok(f.signals.some((signal) => !signal.aborted));
    assert.equal(f.root.querySelector('textarea[aria-label="终端输入"]') === input, true);
    await f.setVisible(false); await settle();
    assert.equal(reader(f.root).getAttribute('aria-label'), '继续读取输出');
    assert.equal(f.signals.every((signal) => signal.aborted), true);
    assert.equal(f.root.querySelector('textarea[aria-label="终端输入"]') === input, true);
    assert.equal(input.value, '仍在编辑的输入草稿');
    assert.equal(f.writes(), 0);
    await f.release();
    assert.equal(f.listeners.size, 0); assert.equal(observers.size, 0);
    assert.equal(input.isConnected, false);
  } finally { await f.dispose(); }
});

test('终端订阅后的快照读取失败时撤销刚登记的监听，不遗留尺寸观察或派发新操作', async () => {
  const f = await fixture(true);
  try {
    await assert.rejects(f.mount(), (error: unknown) => error === f.expected);
    await settle();
    assert.equal(f.listeners.size, 0, '初次校准失败应回收已经登记的可见性监听');
    assert.equal(observers.size, 0); assert.equal(f.writes(), 0);
  } finally { await f.dispose(); }
});
