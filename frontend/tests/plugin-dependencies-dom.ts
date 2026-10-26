import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

export async function dependencyDom() {
  const loader = registerHooks({ load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.tsx')) return {
      shortCircuit: true, format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: url, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
    return nextLoad(url, context);
  } });
  const dom = new JSDOM('<!doctype html><html><body><main id="dependencies"></main></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  const w = dom.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: w, document: w.document, navigator: w.navigator, Element: w.Element, HTMLElement: w.HTMLElement,
    Node: w.Node, NodeFilter: w.NodeFilter, DocumentFragment: w.DocumentFragment, MutationObserver: w.MutationObserver,
    HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement, HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLFormElement: w.HTMLFormElement, HTMLButtonElement: w.HTMLButtonElement, HTMLVideoElement: w.HTMLVideoElement,
    HTMLCanvasElement: w.HTMLCanvasElement, SVGElement: w.SVGElement,
    Event: w.Event, CustomEvent: w.CustomEvent, getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = w.document.getElementById('dependencies');
  assert.ok(container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  return {
    root, document: w.document, container,
    button(label: string, within: ParentNode = w.document) {
      const button = [...within.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label);
      assert.ok(button, `缺少按钮：${label}`);
      return button;
    },
    async close() {
      await act(async () => { root.unmount(); });
      w.close(); loader.deregister();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

export async function settled(condition: () => boolean, message: string): Promise<void> {
  for (let count = 0; count < 200 && !condition(); ++count)
    await act(async () => { await new Promise<void>((done) => setTimeout(done, 5)); });
  assert.ok(condition(), message);
}
