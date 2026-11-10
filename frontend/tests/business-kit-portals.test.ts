import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { act, createElement, createRef, useState } from 'react';
import type { ReactElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { HostUiHolder } from '../src/app/public-ui.ts';
import { unpackPublicPackage } from '../scripts/workspace-release-inputs.ts';

const distributionReport = process.env['DEVICEFORGE_PORTAL_DEVELOPMENT_REPORT'];
let distributionRoot: string | undefined;
const issuedImports = new Map<string, string>();
async function releaseDistribution(): Promise<void> {
  if (!distributionRoot) return;
  const checked = resolve(distributionRoot);
  assert.equal(dirname(checked), resolve(tmpdir()), '只回收本次独立包测试创建的临时目录');
  assert.ok(checked.includes('deviceforge-portal-package-'));
  await rm(checked, { recursive: true, force: true });
  distributionRoot = undefined;
}
if (distributionReport) {
  try {
    const report: unknown = JSON.parse(await readFile(distributionReport, 'utf8'));
    assert.ok(report !== null && typeof report === 'object' && 'packages' in report && Array.isArray(report.packages));
    distributionRoot = await mkdtemp(join(tmpdir(), 'deviceforge-portal-package-'));
    for (const expected of ['@deviceforge/plugin-sdk', '@deviceforge/business-kit']) {
      const entries: unknown[] = report.packages;
      const item = entries.find((entry) => entry !== null && typeof entry === 'object' && 'name' in entry && entry.name === expected);
      assert.ok(item !== null && typeof item === 'object' && 'archive' in item && typeof item.archive === 'string' &&
        'sha256' in item && typeof item.sha256 === 'string');
      const content = await readFile(item.archive);
      assert.equal(createHash('sha256').update(content).digest('hex'), item.sha256);
      const unpacked = await unpackPublicPackage(item.archive, join(distributionRoot, expected.split('/').at(-1) ?? 'invalid'));
      assert.equal(unpacked.name, expected);
      for (const [name, path] of Object.entries(unpacked.imports)) issuedImports.set(name, pathToFileURL(path).href);
    }
    for (const name of ['@deviceforge/plugin-sdk', '@deviceforge/business-kit/dialog',
      '@deviceforge/business-kit/sheet', '@deviceforge/business-kit/select-field'])
      assert.ok(issuedImports.has(name), `实际归档缺少入口，禁止回退源码：${name}`);
  } catch (error) {
    await releaseDistribution();
    throw error;
  }
}

const browser = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031', pretendToBeVisual: true,
});
const document = browser.window.document;
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser.window, document, navigator: browser.window.navigator,
  Element: browser.window.Element, HTMLElement: browser.window.HTMLElement,
  HTMLInputElement: browser.window.HTMLInputElement, HTMLButtonElement: browser.window.HTMLButtonElement,
  HTMLSelectElement: browser.window.HTMLSelectElement, HTMLTextAreaElement: browser.window.HTMLTextAreaElement,
  HTMLFormElement: browser.window.HTMLFormElement, Document: browser.window.Document,
  DocumentFragment: browser.window.DocumentFragment, Node: browser.window.Node,
  NodeFilter: browser.window.NodeFilter, MutationObserver: browser.window.MutationObserver,
  Event: browser.window.Event, CustomEvent: browser.window.CustomEvent,
  MouseEvent: browser.window.MouseEvent, KeyboardEvent: browser.window.KeyboardEvent,
  FocusEvent: browser.window.FocusEvent,
  getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
  requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
  cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const frontend = new URL('../', import.meta.url);
const aliases = new Map<string, string>([
  ['@deviceforge/business-kit/dialog', new URL('../plugins/business-kit/src/react/dialog.tsx', import.meta.url).href],
  ['@deviceforge/business-kit/sheet', new URL('../plugins/business-kit/src/react/sheet.tsx', import.meta.url).href],
  ['@deviceforge/business-kit/select-field', new URL('../plugins/business-kit/src/react/select-field.tsx', import.meta.url).href],
]);
for (const [name, url] of issuedImports) aliases.set(name, url);
const parser = registerHooks({
  resolve(specifier, context, next) {
    const url = aliases.get(specifier);
    if (url) return { url, shortCircuit: true };
    // 归档内ESM只复用公开第三方依赖；相对导入仍在实际解包目录解析。
    if (distributionRoot && context.parentURL?.startsWith(pathToFileURL(distributionRoot).href + '/') &&
        !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':'))
      return next(specifier, { ...context, parentURL: new URL('../package.json', import.meta.url).href });
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(frontend.href)) return next(url, context);
    if (url.endsWith('.css')) return { format: 'module', source: 'export {};', shortCircuit: true };
    if (!url.endsWith('.tsx')) return next(url, context);
    return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: fileURLToPath(url),
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
  },
});
const { installPublicUi } = await import('../src/app/public-ui.ts');
const releasePublicUi = installPublicUi();
const ui = (() => { const value = globalThis.__DEVICEFORGE_HOST_UI__; assert.ok(value); return value; })();
const { resolveOwnedPortalRoot, isManagedPortalRoot } = await import('../src/app/portal-ownership.ts');
const market = await import('../plugins/marketplace/src/workbench/ui.tsx');
const dialog = await import('../plugins/business-kit/src/react/dialog.tsx');
const sheet = await import('../plugins/business-kit/src/react/sheet.tsx');

function anchor(pluginId = 'deviceforge_marketplace') {
  const root = document.createElement('main');
  root.dataset.deviceforgePlugin = pluginId;
  root.dataset.deviceforgeGeneration = '9';
  root.dataset.deviceforgeExtension = `workspace.${pluginId}.main.31`;
  document.body.append(root);
  return root;
}
async function mount(root: HTMLElement, element: ReactElement) {
  let release: ReturnType<typeof ui.mountReact> = () => {};
  await act(async () => { release = ui.mountReact(root, element); });
  return async () => { await act(async () => { await release(); }); };
}
after(async () => {
  await act(async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  releasePublicUi();
  parser.deregister();
  browser.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await releaseDistribution();
});

test('真实市场DialogShell经business-kit独立Dialog挂body后具有当前工作区归属，取消不执行卸载', async () => {
  const root = anchor();
  let cancelled = 0;
  function Confirmation() {
    const [open, setOpen] = useState(true);
    return createElement(market.DialogShell, {
      open, title: '卸载插件', description: '确认卸载 workspace_suite？插件将停止并撤销其扩展。',
      onOpenChange: setOpen,
      footer: createElement(market.Button, {
        type: 'button', onClick: () => { cancelled++; setOpen(false); },
      }, '取消'),
    });
  }
  const release = await mount(root, createElement(Confirmation));
  try {
    const content = document.querySelector('[data-slot="dialog-content"]');
    assert.ok(content);
    assert.equal(content.parentElement, document.body);
    assert.equal(root.contains(content), false);
    assert.match(content.textContent ?? '', /确认卸载 workspace_suite/u);
    assert.ok(resolveOwnedPortalRoot(content)?.anchor === root, '真实市场弹窗应归属当前工作区来源根');
    assert.equal(content.getAttribute('data-deviceforge-plugin'), 'deviceforge_marketplace');
    assert.equal(content.getAttribute('data-deviceforge-generation'), '9');
    const cancel = [...content.querySelectorAll('button')].find((element) => element.textContent === '取消');
    assert.ok(cancel);
    await act(async () => { cancel.click(); });
    assert.equal(cancelled, 1);
    assert.equal(content.isConnected, false);
    assert.equal(resolveOwnedPortalRoot(content), null);
    assert.equal(content.hasAttribute('data-deviceforge-portal'), false);
  } finally { await release(); root.remove(); }
});

test('独立business-kit Sheet经公开mountReact桥保留body位置、ref和props，释放撤销归属', async () => {
  const root = anchor('sheet_plugin');
  const ref = createRef<HTMLDivElement>();
  const release = await mount(root, createElement(sheet.Sheet, { open: true, modal: false },
    createElement(sheet.SheetContent, {
      ref, id: 'independent-sheet', className: 'original-sheet', showCloseButton: false,
      side: 'left', 'aria-describedby': undefined,
    }, createElement(sheet.SheetTitle, null, '独立侧栏'))));
  try {
    const content = document.getElementById('independent-sheet');
    assert.ok(content);
    assert.equal(content.parentElement, document.body);
    assert.equal(ref.current, content);
    assert.equal(content.classList.contains('original-sheet'), true);
    assert.equal(content.classList.contains('left-0'), true);
    assert.ok(resolveOwnedPortalRoot(content)?.anchor === root, '独立Sheet应归属当前插件来源根');
    assert.equal(content.getAttribute('data-deviceforge-plugin'), 'sheet_plugin');
    await release();
    assert.equal(ref.current, null);
    assert.equal(resolveOwnedPortalRoot(content), null);
    assert.equal(isManagedPortalRoot(content), true);
  } finally { await release(); root.remove(); }
});

test('缺可选桥的旧宿主保留Dialog及Sheet原ref与交互，同次挂载不因能力出现改变Hook顺序', async () => {
  const { usePortalContentRef: _optionalBridge, ...legacyUi } = ui;
  assert.equal(Object.hasOwn(legacyUi, 'usePortalContentRef'), false);
  for (const kind of ['dialog', 'sheet']) {
    const root = anchor(`legacy_${kind}`);
    const ref = createRef<HTMLDivElement>();
    let updates = 0;
    globalThis.__DEVICEFORGE_HOST_UI__ = legacyUi;
    function LegacyContent() {
      const [count, setCount] = useState(0);
      const button = createElement('button', {
        type: 'button', onClick: () => { updates++; setCount((value) => value + 1); },
      }, `更新:${count}`);
      if (kind === 'dialog') return createElement(dialog.Dialog, { open: true, modal: false },
        createElement(dialog.DialogContent, {
          ref, id: 'legacy-content', className: 'legacy-original', 'aria-describedby': undefined,
        }, createElement(dialog.DialogTitle, null, '旧版弹窗'), button));
      return createElement(sheet.Sheet, { open: true, modal: false },
        createElement(sheet.SheetContent, {
          ref, id: 'legacy-content', className: 'legacy-original', 'aria-describedby': undefined,
        }, createElement(sheet.SheetTitle, null, '旧版侧栏'), button));
    }
    let release = async () => {};
    try {
      release = await mount(root, createElement(LegacyContent));
      const content = document.getElementById('legacy-content');
      assert.ok(content);
      assert.ok(ref.current === content, '旧宿主应保留外部ref的实际Content引用');
      assert.ok(content.parentElement === document.body);
      assert.equal(content.classList.contains('legacy-original'), true);
      assert.equal(isManagedPortalRoot(content), false);
      assert.equal(content.hasAttribute('data-deviceforge-plugin'), false);
      const update = [...content.querySelectorAll('button')].find((element) => element.textContent === '更新:0');
      assert.ok(update);
      globalThis.__DEVICEFORGE_HOST_UI__ = ui;
      await act(async () => { update.click(); });
      assert.equal(updates, 1);
      assert.ok(ref.current === content, '能力变化不替换当前挂载的Content或ref');
      assert.match(content.textContent ?? '', /更新:1/u);
      assert.equal(isManagedPortalRoot(content), false, '旧挂载不在重渲染中追加Hook或重新认领');
      await release();
      assert.equal(ref.current, null);
      assert.equal(content.isConnected, false);
    } finally {
      await release();
      globalThis.__DEVICEFORGE_HOST_UI__ = ui;
      root.remove();
    }
  }
});
