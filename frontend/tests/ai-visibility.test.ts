import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose, HostContext, WorkspaceInstance, WorkspaceViewContext } from '../src/plugin-sdk/index.ts';
import type { AiServices } from '../plugins/ai/src/services.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

async function fixture(unit: TestContext) {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'http://127.0.0.1:7031/#/ai', pretendToBeVisual: true,
  });
  const w = browser.window, document = w.document;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: w, document, navigator: w.navigator, HTMLElement: w.HTMLElement,
    HTMLInputElement: w.HTMLInputElement, HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement, HTMLSelectElement: w.HTMLSelectElement,
    HTMLFormElement: w.HTMLFormElement, Element: w.Element, Node: w.Node, NodeFilter: w.NodeFilter,
    MutationObserver: w.MutationObserver, DocumentFragment: w.DocumentFragment, CustomEvent: w.CustomEvent,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  unit.mock.method(globalThis, 'fetch', async () => { throw new Error('AI可见性单元禁止真实网络'); });
  const owner = new AbortController(), requests: { path: string; signal: AbortSignal }[] = [];
  let forbiddenCalls = 0, stopped = 0;
  const forbidden = async (): Promise<never> => { forbiddenCalls++; throw new Error('AI页面不得隐式请求或派发业务'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, onDispose: (release) => release, onCleanup: () => () => {},
    listOperations: forbidden, subscribeOperations: () => () => {},
    submit: forbidden, getJob: forbidden, cancelJob: forbidden,
    transport: {
      request(input, signal) {
        assert.equal(input.path, '/api/v2/sessions', '夹具只允许测试显式启动的历史会话观察');
        requests.push({ path: input.path, signal });
        // 用未完成的公开读取模拟正在观察；调用方取消由真实服务模型的abortable负责收敛。
        return new Promise<never>(() => {});
      },
      bytes: forbidden, stream: forbidden,
    },
  };
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const releaseUi = installPublicUi();
  const { createAiServices } = await import('../plugins/ai/src/services.ts');
  const raw = createAiServices(context);
  const services: AiServices = { ...raw, stopWatching() { stopped++; raw.stopWatching(); } };
  const { mountAi } = await import('../plugins/ai/src/view.tsx');
  const target = document.querySelector('main'); assert.ok(target);
  const mounted: Dispose[] = [];
  unit.after(async () => {
    try {
      await act(async () => {
        for (const release of mounted.reverse()) await release();
        await raw.dispose();
      });
      owner.abort(); await releaseUi();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      parser.dispose(); browser.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  function view() {
    let current: WorkspaceInstance = {
      instanceId: 'ai-visibility.main', workspaceId: 'ai-visibility.workspace', pluginId: 'ai-visibility',
      provider: { pluginId: 'ai-visibility', viewId: 'ai-visibility.main' }, target: null,
      visible: true, generation: 1, providerGeneration: 1, state: 'ready', reason: null,
    };
    const listeners = new Set<(visible: boolean) => void>();
    const retained: ((visible: boolean) => void)[] = [];
    const instance: WorkspaceViewContext = {
      signal: owner.signal, snapshot: () => current,
      subscribeVisibility(listener) {
        listeners.add(listener); retained.push(listener);
        return () => { listeners.delete(listener); };
      },
    };
    return { instance, retained, listeners: () => listeners.size,
      setVisible(visible: boolean) {
        current = { ...current, visible };
        for (const listener of [...listeners]) listener(visible);
      },
    };
  }
  return { browser, target, raw, services, requests, view, stopped: () => stopped, forbidden: () => forbiddenCalls,
    async mount(instance: WorkspaceViewContext) {
      let release: Dispose = () => {};
      await act(async () => { release = mountAi(target, services, instance); });
      mounted.push(release); return release;
    },
    mountInitial(instance: WorkspaceViewContext) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: false });
      try {
        // 首次同步API的错误由宿主onUncaughtError处理，不能让act代收而绕过原回滚通路。
        const release = mountAi(target, services, instance);
        mounted.push(release); return release;
      } finally {
        if (descriptor) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', descriptor);
        else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    },
  };
}

function prompt(root: ParentNode) {
  const input = root.querySelector<HTMLTextAreaElement>('textarea[id$="-assistant-prompt-sdk"]');
  assert.ok(input); return input;
}
async function type(input: HTMLTextAreaElement, value: string) {
  const w = input.ownerDocument.defaultView; assert.ok(w);
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value')?.set; assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new w.Event('input', { bubbles: true })); });
}

test('AI订阅建立间隙已隐藏时停止原观察，保留草稿且卸载后旧通知无效', async (unit) => {
  const f = await fixture(unit), current = f.view();
  let observation: Promise<unknown> = Promise.resolve(), switched = false;
  const caller = new AbortController();
  const instance: WorkspaceViewContext = {
    ...current.instance,
    subscribeVisibility(listener) {
      if (!switched) {
        switched = true;
        // 此处在真实页面已读取状态后开始观察，并在登记监听前隐藏；不回放这次切换。
        observation = f.raw.sdkStreaming.refreshRecords(caller.signal).then(
          () => ({ completed: true }), (error: unknown) => ({ error }));
        current.setVisible(false);
      }
      return current.instance.subscribeVisibility(listener);
    },
  };
  const release = await f.mount(instance);
  assert.equal(switched, true);
  assert.equal(current.instance.snapshot().visible, false);
  assert.equal(f.stopped(), 1, '订阅后必须按最新隐藏快照停止已有观察');
  assert.equal(f.requests.length, 1, '只允许夹具显式启动的一次观察读取');
  assert.equal(f.requests[0]?.signal.aborted, true);
  await observation;
  const input = prompt(f.target);
  await type(input, '切页仍保留这份AI草稿');
  await act(async () => { current.setVisible(true); current.setVisible(false); });
  assert.equal(f.stopped(), 2);
  assert.equal(prompt(f.target), input);
  assert.equal(input.value, '切页仍保留这份AI草稿');
  await act(async () => { await release(); });
  assert.equal(current.listeners(), 0);
  assert.equal(f.target.childElementCount, 0);
  const afterRelease = f.stopped();
  await act(async () => { for (const listener of current.retained) listener(false); });
  assert.equal(f.stopped(), afterRelease, '已撤销的同代旧通知不能再次干扰AI观察');
  assert.equal(f.raw.drafts.sdk.prompt, '切页仍保留这份AI草稿');
  assert.equal(f.requests.length, 1);
  assert.equal(f.forbidden(), 0);
});

test('AI订阅后校准快照抛原错误时回收监听及部分DOM，同根独立新挂载继续', async (unit) => {
  const warnings: { level: string; values: readonly unknown[] }[] = [];
  const originalError = console.error.bind(console), originalWarn = console.warn.bind(console);
  unit.mock.method(console, 'error', (...values: unknown[]) => {
    warnings.push({ level: 'error', values }); originalError(...values);
  });
  unit.mock.method(console, 'warn', (...values: unknown[]) => {
    warnings.push({ level: 'warn', values }); originalWarn(...values);
  });
  const f = await fixture(unit), broken = f.view();
  const expected = new Error('AI可见性校准读取失败');
  let subscribed = false, failedReads = 0;
  const instance: WorkspaceViewContext = {
    ...broken.instance,
    snapshot() {
      if (subscribed) { failedReads++; throw expected; }
      return broken.instance.snapshot();
    },
    subscribeVisibility(listener) {
      const release = broken.instance.subscribeVisibility(listener);
      subscribed = true;
      return release;
    },
  };
  assert.throws(() => f.mountInitial(instance), (error: unknown) => error === expected,
    '首次effect校准失败必须返回原Error，不能冒充挂载成功');
  await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
  assert.equal(failedReads, 1);
  assert.equal(broken.listeners(), 0, '校准失败后必须撤销刚登记的监听');
  assert.equal(f.target.childElementCount, 0);
  const fresh = f.view();
  const release = await f.mount(fresh.instance);
  const input = prompt(f.target);
  await type(input, '独立新挂载草稿');
  assert.equal(input.value, '独立新挂载草稿');
  await act(async () => { await release(); });
  assert.equal(fresh.listeners(), 0);
  assert.equal(f.target.childElementCount, 0);
  assert.equal(f.requests.length, 0, '校准或新挂载不得隐式联网');
  assert.equal(f.forbidden(), 0);
  assert.deepEqual(warnings, [], '校准失败回滚及同根新挂载不得出现重复createRoot或其他控制台告警');
});
