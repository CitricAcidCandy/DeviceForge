import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { hostUi } from '../src/plugin-sdk/index.ts';
import type { HostUiHolder } from '../src/app/public-ui.ts';

type Install = (target?: HostUiHolder) => () => void;

// 组件桶里是 .tsx，Node 的类型剥离不支持，必须借 Vite 转译后再加载。
function installBrowser() {
  const browser = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:7031',
    pretendToBeVisual: true,
  });
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef,
    document: windowRef.document,
    navigator: windowRef.navigator,
    Element: windowRef.Element,
    DocumentFragment: windowRef.DocumentFragment,
    HTMLElement: windowRef.HTMLElement,
    HTMLButtonElement: windowRef.HTMLButtonElement,
    SVGElement: windowRef.SVGElement,
    Node: windowRef.Node,
    MutationObserver: windowRef.MutationObserver,
    Event: windowRef.Event,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return windowRef;
}

const windowRef = installBrowser();
let started: Promise<ViteDevServer> | null = null;
function devServer(): Promise<ViteDevServer> {
  started ??= createServer({ server: { middlewareMode: true }, appType: 'custom' });
  return started;
}
async function installPublicUi(): Promise<Install> {
  const server = await devServer();
  const module = await server.ssrLoadModule('/src/app/public-ui.ts');
  const install = module['installPublicUi'];
  assert.equal(typeof install, 'function');
  return install as Install;
}

test.after(async () => {
  await (await started)?.close();
});

test('界面套件：未安装时明确报错，安装后可取用，释放后还原', async () => {
  const install = await installPublicUi();
  assert.equal(globalThis.__DEVICEFORGE_HOST_UI__, undefined);
  assert.throws(() => hostUi(), /宿主未提供界面套件/u);

  const release = install();
  const ui = hostUi();
  assert.equal(ui.apiVersion, 1);
  for (const name of ['Button', 'Input', 'Select', 'Tabs', 'Table', 'mountReact', 'cn'] as const)
    assert.equal(typeof ui[name], 'function');

  release();
  assert.equal(globalThis.__DEVICEFORGE_HOST_UI__, undefined);
  assert.throws(() => hostUi(), /宿主未提供界面套件/u);
});

test('mountReact：用宿主组件渲染到插件节点，释放后清空', async () => {
  const install = await installPublicUi();
  const release = install();
  try {
    const ui = hostUi();
    const host = windowRef.document.createElement('div');
    const unmount = ui.mountReact(host, createElement(ui.Button, { type: 'button' }, '插件按钮'));
    const rendered = host.querySelector('button');
    assert.equal(rendered?.textContent, '插件按钮');
    // 类名带着宿主主题里的令牌，证明用的是宿主那套组件，而不是插件自带的副本。
    assert.equal(rendered?.className.includes('bg-primary'), true);
    unmount();
    assert.equal(host.innerHTML, '');
  } finally {
    release();
  }
});

test('垫片：只从全局契约取值，且导出的名字宿主都提供', async () => {
  const install = await installPublicUi();
  const release = install();
  try {
    const shimPath = resolve(import.meta.dirname, '../public/plugin-host.js');
    const shim: Record<string, unknown> = await import(pathToFileURL(shimPath).href);
    const ui = hostUi() as unknown as Record<string, unknown>;
    const source = await readFile(shimPath, 'utf8');
    // 垫片自己不能带 React：带了就是第二份实例，hooks 与 context 全部失效。
    assert.equal(/\bfrom\s+['"]react/.test(source), false);
    // default 与 createRoot 是从契约派生的便捷导出，不要求契约有同名成员。
    const derived = new Set(['default', 'createRoot']);
    for (const [name, value] of Object.entries(shim)) {
      if (derived.has(name)) continue;
      assert.equal(name in ui, true, `垫片导出的 ${name} 在宿主契约里不存在`);
      assert.equal(typeof value, typeof ui[name], `垫片导出的 ${name} 类型与宿主不一致`);
    }
    assert.equal(shim['apiVersion'], 1);
  } finally {
    release();
  }
});
