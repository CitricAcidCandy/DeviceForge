import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import type { TerminalSize } from '../src/features/interactive-sessions/index.ts';
import type { TerminalViewportHandle } from '../src/pages/terminal/TerminalViewport.tsx';
import { createTerminalInputQueue } from '../src/pages/terminal/input-queue.ts';
import { deferred } from './fixtures.ts';

interface ViewportProps {
  chunks: [];
  writable: boolean;
  handle: { current: TerminalViewportHandle | null };
  onData(text: string): void;
  onResize(size: TerminalSize): void;
}

function viewportModule(value: unknown): value is {
  TerminalViewport: ComponentType<ViewportProps>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'TerminalViewport' in value &&
    typeof value.TerminalViewport === 'function'
  );
}

const fakeTerminal = `
export class Terminal {
  constructor(options) { this.options = options; this.cols = options.cols; this.rows = options.rows; }
  loadAddon() {}
  open(node) { this.textarea = document.createElement('textarea'); node.append(this.textarea); }
  onData() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  focus() {}
  write() {}
  dispose() { this.textarea?.remove(); }
}
`;

test('初次fit早于可写时，启用输入补发当前尺寸并等待同一队列的收据', async () => {
  const browser = new JSDOM('<div id="terminal-test"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost',
  });
  const windowRef = browser.window;
  const observed: ResizeObserverCallback[] = [];
  class Observer {
    constructor(callback: ResizeObserverCallback) {
      observed.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef,
    document: windowRef.document,
    navigator: windowRef.navigator,
    HTMLElement: windowRef.HTMLElement,
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef),
    ResizeObserver: Observer,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperties(windowRef.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 800 },
    clientHeight: { configurable: true, get: () => 240 },
  });
  const server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    plugins: [
      {
        name: 'terminal-viewport-test-emulator',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@xterm/xterm') return '\0terminal-viewport-test-xterm';
          if (id === '@xterm/addon-fit') return '\0terminal-viewport-test-fit';
          if (id.endsWith('/@xterm/xterm/css/xterm.css')) return '\0terminal-viewport-test-css';
        },
        load(id) {
          if (id === '\0terminal-viewport-test-xterm') return fakeTerminal;
          if (id === '\0terminal-viewport-test-fit')
            return 'export class FitAddon { proposeDimensions() { return { cols: 80, rows: 24 }; } }';
          if (id === '\0terminal-viewport-test-css') return 'export {};';
        },
      },
    ],
    ssr: { noExternal: ['@xterm/xterm', '@xterm/addon-fit'] },
  });
  const target = windowRef.document.getElementById('terminal-test');
  assert.ok(target);
  const root = createRoot(target);
  const gate = deferred<void>();
  const sent: unknown[] = [];
  const queue = createTerminalInputQueue(
    async (message) => {
      sent.push(message);
      if (sent.length === 1) await gate.promise;
    },
    (error) => assert.fail(String(error)),
  );
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/pages/terminal/TerminalViewport.tsx');
    assert.ok(viewportModule(loaded));
    const handle: { current: TerminalViewportHandle | null } = { current: null };
    const render = async (writable: boolean) => {
      await act(async () => {
        root.render(
          createElement(loaded.TerminalViewport, {
            chunks: [],
            writable,
            handle,
            onData: (text) => queue.input(text),
            onResize: (size) => {
              if (writable) queue.resize(size);
            },
          }),
        );
      });
    };
    await render(false);
    for (let attempt = 0; attempt < 30 && handle.current?.size().cols !== 80; attempt++)
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      });
    assert.deepEqual(handle.current?.size(), { cols: 80, rows: 24 });
    assert.equal(observed.length, 1);
    assert.deepEqual(sent, []);
    await render(true);
    assert.deepEqual(sent, [{ type: 'resize', cols: 80, rows: 24 }]);
    queue.input('codex\r');
    assert.equal(sent.length, 1);
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(sent[1], { type: 'input', text: 'codex\r' });
  } finally {
    queue.dispose();
    gate.resolve();
    await act(async () => root.unmount());
    await server.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    browser.window.close();
  }
});
