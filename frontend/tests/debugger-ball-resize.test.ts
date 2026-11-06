import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import { act, createElement } from 'react';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import ts from 'typescript';

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react' || specifier.startsWith('react/')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.tsx')) {
      return { shortCircuit: true, format: 'module', source: ts.transpileModule(
        readFileSync(new URL(url), 'utf8'), { fileName: url, compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
        } },
      ).outputText };
    }
    return nextLoad(url, context);
  },
});
const { DebuggerApp } = await import('../../examples/browser-debugger/src/view.tsx');
const { createDebuggerController } = await import('../../examples/browser-debugger/src/controller.ts');
test.after(() => loader.deregister());

interface Fixture {
  readonly dom: JSDOM;
  readonly root: HTMLElement;
  readonly ball: HTMLButtonElement;
  resize(widths: readonly number[]): Promise<void>;
  observeViewport(width: number): Promise<void>;
  moveLeft(): Promise<void>;
  unmount(): Promise<void>;
  pendingFrames(): number;
}

async function withDebugger(run: (fixture: Fixture) => Promise<void>) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    // JSDOM 不支持调试器已有的作用域样式；坐标断言读取真实 DOM 上的自定义属性。
    if ('type' in error && error.type === 'css-parsing') return;
    throw error;
  });
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', {
    url: 'https://example.invalid/', pretendToBeVisual: true, virtualConsole,
  });
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, writable: true, value: 480 });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, writable: true, value: 760 });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  dom.window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  dom.window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const globals: Readonly<Record<string, unknown>> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    Event: dom.window.Event, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let businessCalls = 0;
  const unexpected = async () => { businessCalls++; throw new Error('悬浮球尺寸变化不得调用业务或连接'); };
  const lifetime = new AbortController();
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, listOperations: unexpected, submit: unexpected,
    getJob: unexpected, cancelJob: unexpected, subscribeOperations: () => () => {}, onDispose: (dispose) => dispose,
  };
  const controller = createDebuggerController(context);
  const element = dom.window.document.querySelector<HTMLElement>('#root'); assert.ok(element);
  const { createRoot } = await import('react-dom/client');
  const viewRoot = createRoot(element);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => viewRoot.unmount());
  };
  const flushFrames = async () => {
    await act(async () => {
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); }
    });
  };
  try {
    await act(async () => viewRoot.render(createElement(DebuggerApp, { controller, context })));
    await flushFrames();
    const ball = element.querySelector<HTMLButtonElement>('button[aria-label="打开调试器"]'); assert.ok(ball);
    await run({
      dom, root: element, ball, unmount, pendingFrames: () => frames.size,
      resize: async (widths) => {
        await act(async () => {
          for (const width of widths) {
            Object.defineProperty(dom.window, 'innerWidth', { configurable: true, writable: true, value: width });
            dom.window.dispatchEvent(new dom.window.Event('resize'));
          }
        });
        await flushFrames();
      },
      observeViewport: async (width) => {
        await act(async () => {
          Object.defineProperty(dom.window, 'innerWidth', { configurable: true, writable: true, value: width });
          const content = dom.window.document.createElement('div');
          content.textContent = '业务内容发生变化';
          dom.window.document.body.append(content);
          dom.window.document.dispatchEvent(new dom.window.Event('scroll'));
        });
        await flushFrames();
      },
      moveLeft: async () => {
        await act(async () => {
          for (let step = 0; step < 13; step++) {
            ball.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
              bubbles: true, key: 'ArrowLeft', altKey: true, shiftKey: true,
            }));
          }
        });
        await flushFrames();
      },
    });
    assert.equal(controller.snapshot().open, false);
    assert.equal(businessCalls, 0, '所有操作均只作用于收起的悬浮入口');
  } finally {
    await unmount();
    await controller.dispose();
    lifetime.abort();
    const remainingFrames = frames.size;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    assert.equal(remainingFrames, 0, '卸载应撤销尚未执行的避让帧');
  }
}

function xOf(ball: HTMLButtonElement) {
  return Number.parseFloat(ball.style.getPropertyValue('--df-x'));
}

test('调试球默认右侧停靠在480到桌面再返回窄窗时保持同侧', async () => {
  await withDebugger(async ({ ball, root, resize }) => {
    assert.equal(xOf(ball), 416, '初始480宽应停靠右侧并保留16像素边距');
    for (const width of [1424, 940, 480]) {
      await resize([width]);
      assert.equal(xOf(ball), width - 64, `${width}宽应保持原右侧停靠`);
      assert.equal(root.querySelector('button[aria-label="打开调试器"]'), ball, '尺寸变化不重建悬浮入口');
    }
  });
});

test('调试球经键盘明确移到左侧后尺寸往返保持左侧', async () => {
  await withDebugger(async ({ ball, resize, moveLeft }) => {
    await moveLeft();
    assert.equal(xOf(ball), 16, '真实Alt加方向键事件应把球移至左侧');
    for (const width of [1424, 940, 480]) {
      await resize([width]);
      assert.equal(xOf(ball), 16, `${width}宽不能覆盖用户选择的左侧`);
    }
  });
});

test('调试球连续尺寸事件不遗失停靠侧且卸载撤销观察帧和根', async () => {
  await withDebugger(async ({ dom, root, ball, resize, unmount, pendingFrames }) => {
    for (let round = 0; round < 4; round++) {
      await resize([1424, 940, 480]);
      assert.equal(root.querySelectorAll('button[aria-label="打开调试器"]').length, 1);
      assert.equal(root.querySelector('button[aria-label="打开调试器"]'), ball);
      assert.equal(xOf(ball), 416, '同一React批次内连续resize仍按原右侧停靠');
      assert.equal(pendingFrames(), 0);
    }
    await unmount();
    assert.equal(root.childElementCount, 0);
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    dom.window.document.dispatchEvent(new dom.window.Event('scroll'));
    assert.equal(pendingFrames(), 0, '卸载后resize或scroll不得重新登记避让帧');
  });
});

test('调试球先按新视口执行避让帧再收到resize时仍保持原右侧', async () => {
  await withDebugger(async ({ ball, resize, observeViewport }) => {
    await resize([940]);
    assert.equal(xOf(ball), 876, '940宽的原停靠位置应在右侧');
    await observeViewport(480);
    assert.equal(xOf(ball), 416, '原避让观察帧应先把球收回480宽视口');
    await resize([480]);
    assert.equal(xOf(ball), 416, '后到的resize不能把避让后的右侧坐标误判成左侧');
  });
});
