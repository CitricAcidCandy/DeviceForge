import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { act, createElement, createRef, useState } from 'react';
import type { ReactElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { HostUiHolder } from '../src/app/public-ui.ts';

const browser = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031', pretendToBeVisual: true,
});
const document = browser.window.document;
Object.defineProperty(browser.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true, value() {},
});
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
  MouseEvent: browser.window.MouseEvent, PointerEvent: browser.window.MouseEvent,
  KeyboardEvent: browser.window.KeyboardEvent, FocusEvent: browser.window.FocusEvent,
  getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
  requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
  cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const frontend = new URL('../', import.meta.url);
const parser = registerHooks({
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
const { DialogShell } = await import('../src/components/DialogShell/index.tsx');
const { Dialog, DialogContent, DialogTitle, DialogDescription } = await import('../src/components/Dialog/index.tsx');
const { PortalBoundary, usePortalContentRef } = await import('../src/components/PortalBoundary/index.tsx');
const { createPortalOwnership, resolveOwnedPortalRoot, isManagedPortalRoot } = await import('../src/app/portal-ownership.ts');
const sheet = await import('../src/components/Sheet/index.tsx');
const dropdown = await import('../src/components/DropdownMenu/index.tsx');
const select = await import('../src/components/Select/index.tsx');
const tooltip = await import('../src/components/Tooltip/index.tsx');
const holder: HostUiHolder = {};
const releasePublicUi = installPublicUi(holder);
const ui = (() => { const value = holder.__DEVICEFORGE_HOST_UI__; assert.ok(value); return value; })();

function anchor(pluginId = 'example', generation = '7', contribution = `${pluginId}.main`) {
  const root = document.createElement('main');
  root.dataset.deviceforgePlugin = pluginId;
  root.dataset.deviceforgeGeneration = generation;
  root.dataset.deviceforgeExtension = contribution;
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
});

test('真实DialogShell仍Portal到body，但通过宿主根归属标记实际Content而不标Overlay', async () => {
  const root = anchor();
  const release = await mount(root, createElement(DialogShell, {
    open: true, onOpenChange() {}, title: '卸载确认', description: '不执行实际卸载',
    footer: createElement('button', { type: 'button' }, '确认'),
  }));
  try {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    assert.ok(dialog && overlay);
    assert.equal(root.contains(dialog), false);
    assert.equal(dialog.parentElement, document.body);
    assert.equal(dialog.getAttribute('data-deviceforge-plugin'), 'example');
    assert.equal(dialog.getAttribute('data-deviceforge-generation'), '7');
    assert.match(dialog.getAttribute('data-deviceforge-extension') ?? '', /^example\.main\.portal\./u);
    assert.equal(resolveOwnedPortalRoot(dialog)?.anchor, root);
    assert.equal(isManagedPortalRoot(dialog), true);
    assert.equal(overlay.hasAttribute('data-deviceforge-plugin'), false);
    assert.equal(overlay.hasAttribute('data-deviceforge-extension'), false);
  } finally { await release(); root.remove(); }
});

test('Content保留外部object ref、原props和事件，关闭撤销归属而不改Portal位置', async () => {
  const root = anchor();
  const ref = createRef<HTMLDivElement>();
  let close = () => {};
  let clicks = 0;
  function Content() {
    const [open, setOpen] = useState(true);
    close = () => setOpen(false);
    return createElement(Dialog, { open, modal: false, onOpenChange: setOpen },
      createElement(DialogContent, {
        ref, id: 'owned-dialog', className: 'existing-dialog-class', title: '保留原props',
        'aria-label': '业务确认', onClick: () => { clicks++; },
        onOpenAutoFocus: (event) => event.preventDefault(),
      }, createElement(DialogTitle, null, '弹层标题'), createElement(DialogDescription, null, '弹层说明')));
  }
  const release = await mount(root, createElement(Content));
  try {
    const content = document.getElementById('owned-dialog');
    assert.ok(content);
    assert.equal(ref.current, content);
    assert.equal(content.parentElement, document.body);
    assert.equal(content.getAttribute('title'), '保留原props');
    assert.equal(content.getAttribute('aria-label'), '业务确认');
    assert.equal(content.classList.contains('existing-dialog-class'), true);
    assert.ok(content.classList.contains('fixed'));
    assert.equal(resolveOwnedPortalRoot(content)?.anchor, root);
    await act(async () => { content.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true })); });
    assert.equal(clicks, 1);
    await act(async () => { close(); });
    assert.equal(ref.current, null);
    assert.equal(content.isConnected, false);
    assert.equal(resolveOwnedPortalRoot(content), null);
    assert.equal(content.hasAttribute('data-deviceforge-portal'), false);
    assert.equal(isManagedPortalRoot(content), true);
  } finally { await release(); root.remove(); }
});

test('回调ref的React19释放保留且只调用一次，宿主归属先于外部清理撤销', async () => {
  const root = anchor();
  let attached: HTMLDivElement | null = null;
  let releases = 0, nullCalls = 0;
  const ref = (element: HTMLDivElement | null) => {
    if (element === null) { nullCalls++; return; }
    attached = element;
    return () => {
      releases++;
      assert.equal(resolveOwnedPortalRoot(element), null);
    };
  };
  const release = await mount(root, createElement(Dialog, { open: true, modal: false },
    createElement(DialogContent, { ref, 'aria-describedby': undefined },
      createElement(DialogTitle, null, '回调ref'))));
  try {
    const content = attached;
    assert.ok(content);
    assert.equal(resolveOwnedPortalRoot(content)?.anchor, root);
    await release();
    await release();
    assert.equal(releases, 1);
    assert.equal(nullCalls, 0);
    assert.equal(resolveOwnedPortalRoot(content), null);
  } finally { await release(); root.remove(); }
});

test('同插件同代不同来源贡献各自拥有唯一弹层，撤销一处不影响其他插件', async () => {
  const first = anchor('first', '1', 'first.left');
  const second = anchor('first', '1', 'first.right');
  const foreign = anchor('foreign', '4');
  const scopes = [first, second, foreign].map(createPortalOwnership);
  const contents = [first, second, foreign].map(() => {
    const element = document.createElement('div'); document.body.append(element); return element;
  });
  try {
    scopes.forEach((scope, index) => { const content = contents[index]; assert.ok(content); scope.register(content); });
    assert.equal(new Set(contents.map((element) => element.getAttribute('data-deviceforge-extension'))).size, 3);
    contents.forEach((content, index) => assert.equal(resolveOwnedPortalRoot(content)?.anchor, [first, second, foreign][index]));
    scopes[0]?.dispose();
    assert.equal(resolveOwnedPortalRoot(contents[0] ?? document.body), null);
    assert.equal(resolveOwnedPortalRoot(contents[1] ?? document.body)?.anchor, second);
    assert.equal(resolveOwnedPortalRoot(contents[2] ?? document.body)?.anchor, foreign);
  } finally { scopes.forEach((scope) => scope.dispose()); contents.forEach((content) => content.remove()); first.remove(); second.remove(); foreign.remove(); }
});

test('最近嵌套provider决定归属，祖先归属变化不越权认领内层且源根断开立即失效', () => {
  const outer = anchor('outer', '1');
  const nested = anchor('nested', '8');
  outer.append(nested);
  const renderTarget = document.createElement('div');
  nested.append(renderTarget);
  const scope = createPortalOwnership(renderTarget);
  const content = document.createElement('div');
  document.body.append(content);
  try {
    scope.register(content);
    assert.equal(resolveOwnedPortalRoot(content)?.anchor, nested);
    assert.equal(content.getAttribute('data-deviceforge-plugin'), 'nested');
    outer.dataset.deviceforgeGeneration = '20';
    assert.equal(resolveOwnedPortalRoot(content)?.anchor, nested);
    nested.remove();
    assert.equal(resolveOwnedPortalRoot(content), null);
    assert.equal(content.hasAttribute('data-deviceforge-plugin'), false);
    outer.append(nested);
    assert.equal(resolveOwnedPortalRoot(content), null, '旧绑定失效后重连不自动复活');
  } finally { scope.dispose(); content.remove(); outer.remove(); }
});

test('源根panel或extension、plugin及generation变化均撤销旧身份，拒绝标记伪造与其他节点', () => {
  for (const [attribute, changed] of [
    ['data-deviceforge-panel', 'example.other-panel'],
    ['data-deviceforge-extension', 'example.reused'],
    ['data-deviceforge-plugin', 'foreign'],
    ['data-deviceforge-generation', '8'],
  ]) {
    assert.ok(attribute && changed);
    const root = anchor();
    root.setAttribute('data-deviceforge-panel', 'example.panel');
    const scope = createPortalOwnership(root);
    const content = document.createElement('div');
    document.body.append(content);
    try {
      scope.register(content);
      assert.equal(resolveOwnedPortalRoot(content)?.anchor, root);
      root.setAttribute(attribute, changed);
      assert.equal(resolveOwnedPortalRoot(content), null);
      assert.equal(content.hasAttribute('data-deviceforge-portal'), false);
      assert.equal(isManagedPortalRoot(content), true);
    } finally { scope.dispose(); content.remove(); root.remove(); }
  }
  const forged = document.createElement('div');
  forged.setAttribute('data-deviceforge-portal', 'copied-marker');
  document.body.append(forged);
  try {
    assert.equal(isManagedPortalRoot(forged), true);
    assert.equal(resolveOwnedPortalRoot(forged), null);
    assert.equal(isManagedPortalRoot(document.body), false);
  } finally { forged.remove(); }
});

test('无所属mountReact根、最近不完整根及debugger内部来源均不认领共享或原生自建Portal', async () => {
  const ordinary = document.createElement('main');
  document.body.append(ordinary);
  const release = await mount(ordinary, createElement(DialogShell, {
    open: true, onOpenChange() {}, title: '宿主自己的弹窗',
  }));
  try {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    assert.ok(dialog);
    assert.equal(isManagedPortalRoot(dialog), false);
    assert.equal(resolveOwnedPortalRoot(dialog), null);
    assert.equal(dialog.hasAttribute('data-deviceforge-plugin'), false);
  } finally { await release(); ordinary.remove(); }
  const outer = anchor();
  const nested = document.createElement('div');
  nested.dataset.deviceforgePlugin = 'foreign';
  outer.append(nested);
  const internal = document.createElement('section');
  internal.dataset.deviceforgeDebuggerInternal = '';
  const insideInternal = document.createElement('div');
  internal.append(insideInternal);
  outer.append(internal);
  const sources = [nested, insideInternal];
  const contents: HTMLElement[] = [];
  try {
    for (const source of sources) {
      const scope = createPortalOwnership(source);
      const content = document.createElement('div');
      contents.push(content); document.body.append(content);
      scope.register(content);
      assert.equal(isManagedPortalRoot(content), false);
      assert.equal(resolveOwnedPortalRoot(content), null);
      scope.dispose();
    }
    const raw = document.createElement('div');
    const stop = await mount(outer, ui.ReactDOM.createPortal(createElement('span', { id: 'raw-portal' }, '原生Portal'), raw));
    const content = raw.firstElementChild;
    assert.ok(content);
    assert.equal(isManagedPortalRoot(content), false);
    assert.equal(resolveOwnedPortalRoot(content), null);
    await stop();
  } finally { contents.forEach((element) => element.remove()); outer.remove(); }
});

test('作用域同步撤资格后晚到ref不能复活，旧释放不误删新代绑定或他人新属性', () => {
  const root = anchor();
  const content = document.createElement('div');
  content.setAttribute('data-deviceforge-extension', 'existing-prop');
  document.body.append(content);
  const first = createPortalOwnership(root);
  try {
    const oldRelease = first.register(content);
    assert.equal(resolveOwnedPortalRoot(content)?.anchor, root);
    first.dispose();
    assert.equal(content.getAttribute('data-deviceforge-extension'), 'existing-prop');
    assert.equal(content.hasAttribute('data-deviceforge-plugin'), false);
    first.register(content);
    assert.equal(content.hasAttribute('data-deviceforge-portal'), false);
    const second = createPortalOwnership(root);
    try {
      second.register(content);
      const marker = content.getAttribute('data-deviceforge-portal');
      oldRelease();
      assert.equal(content.getAttribute('data-deviceforge-portal'), marker);
      assert.equal(resolveOwnedPortalRoot(content)?.anchor, root);
      content.setAttribute('data-deviceforge-plugin', 'someone-else');
      second.dispose();
      assert.equal(content.getAttribute('data-deviceforge-plugin'), 'someone-else');
      assert.equal(content.getAttribute('data-deviceforge-extension'), 'existing-prop');
      assert.equal(resolveOwnedPortalRoot(content), null);
    } finally { second.dispose(); }
  } finally { first.dispose(); content.remove(); root.remove(); }
});

test('弹层来源可以是有效宿主弹层，但来源链撤销后子弹层也失效且不能复制标记认领', () => {
  const root = anchor();
  const parent = document.createElement('div');
  const child = document.createElement('div');
  const nestedTarget = document.createElement('div');
  parent.append(nestedTarget);
  document.body.append(parent, child);
  const first = createPortalOwnership(root);
  const parentRelease = first.register(parent);
  const second = createPortalOwnership(nestedTarget);
  try {
    second.register(child);
    assert.equal(resolveOwnedPortalRoot(child)?.anchor, parent);
    parentRelease();
    assert.equal(resolveOwnedPortalRoot(child), null);
    assert.equal(child.hasAttribute('data-deviceforge-portal'), false);
  } finally { second.dispose(); first.dispose(); parent.remove(); child.remove(); root.remove(); }
});

test('中性PortalBoundary不解释业务身份，保留回调ref的旧式null通知和释放顺序', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const events: string[] = [];
  function Reported() {
    const ref = usePortalContentRef<HTMLDivElement>((element) => { events.push(element ? 'ref' : 'null'); });
    return createElement('div', { ref, id: 'neutral-content' });
  }
  const release = await mount(root, createElement(PortalBoundary, {
    report(element) {
      assert.equal(element.id, 'neutral-content');
      events.push('report');
      return () => { events.push('release'); };
    },
    children: createElement(Reported),
  }));
  try {
    assert.deepEqual(events, ['report', 'ref']);
    assert.equal(document.getElementById('neutral-content')?.hasAttribute('data-deviceforge-plugin'), false);
    await release();
    assert.deepEqual(events, ['report', 'ref', 'release', 'null']);
  } finally { await release(); root.remove(); }
});

for (const kind of ['sheet', 'dropdown', 'select', 'tooltip'] satisfies readonly string[]) {
  test(`共享${kind}实际Content报告所属并保留外部ref和样式属性`, async () => {
    const root = anchor();
    const ref = createRef<HTMLDivElement>();
    let element: ReactElement;
    if (kind === 'sheet') {
      element = createElement(sheet.Sheet, { open: true, modal: false },
        createElement(sheet.SheetContent, {
          ref, id: 'shared-portal-content', className: 'original-content-class',
          'aria-describedby': undefined, showCloseButton: false,
        }, createElement(sheet.SheetTitle, null, '抽屉')));
    } else if (kind === 'dropdown') {
      element = createElement(dropdown.DropdownMenu, { open: true, modal: false },
        createElement(dropdown.DropdownMenuTrigger, null, '菜单'),
        createElement(dropdown.DropdownMenuContent, {
          ref, id: 'shared-portal-content', className: 'original-content-class',
        }, createElement(dropdown.DropdownMenuItem, null, '菜单项')));
    } else if (kind === 'select') {
      element = createElement(select.Select, { open: true, defaultValue: 'one' },
        createElement(select.SelectTrigger, { 'aria-label': '选项' }, createElement(select.SelectValue)),
        createElement(select.SelectContent, {
          ref, position: 'popper', id: 'shared-portal-content', className: 'original-content-class',
        }, createElement(select.SelectItem, { value: 'one' }, '第一项')));
    } else {
      element = createElement(tooltip.TooltipProvider, null,
        createElement(tooltip.Tooltip, { open: true },
          createElement(tooltip.TooltipTrigger, null, '提示目标'),
          createElement(tooltip.TooltipContent, {
            ref, id: 'shared-portal-content', className: 'original-content-class',
          }, '提示内容')));
    }
    const release = await mount(root, element);
    try {
      const content = document.getElementById('shared-portal-content');
      assert.ok(content);
      assert.equal(ref.current, content);
      assert.equal(content.classList.contains('original-content-class'), true);
      assert.equal(root.contains(content), false);
      assert.equal(document.body.contains(content), true);
      assert.equal(resolveOwnedPortalRoot(content)?.anchor, root);
      assert.equal(content.getAttribute('data-deviceforge-plugin'), 'example');
      await release();
      assert.equal(ref.current, null);
      assert.equal(resolveOwnedPortalRoot(content), null);
      assert.equal(content.hasAttribute('data-deviceforge-portal'), false);
    } finally { await release(); root.remove(); }
  });
}

test('Dropdown子菜单Content拥有独立surface且不替换父菜单或外部ref', async () => {
  const root = anchor();
  const ref = createRef<HTMLDivElement>();
  const release = await mount(root, createElement(dropdown.DropdownMenu, { open: true, modal: false },
    createElement(dropdown.DropdownMenuTrigger, null, '菜单'),
    createElement(dropdown.DropdownMenuContent, { id: 'parent-menu' },
      createElement(dropdown.DropdownMenuSub, { open: true },
        createElement(dropdown.DropdownMenuSubTrigger, null, '更多'),
        createElement(dropdown.DropdownMenuSubContent, {
          ref, id: 'child-menu', className: 'original-child-class',
        }, createElement(dropdown.DropdownMenuItem, null, '子菜单项'))))));
  try {
    const parent = document.getElementById('parent-menu');
    const child = document.getElementById('child-menu');
    assert.ok(parent && child);
    assert.equal(ref.current, child);
    assert.equal(child.classList.contains('original-child-class'), true);
    assert.equal(resolveOwnedPortalRoot(parent)?.anchor, root);
    assert.equal(resolveOwnedPortalRoot(child)?.anchor, root);
    assert.notEqual(parent.getAttribute('data-deviceforge-extension'), child.getAttribute('data-deviceforge-extension'));
  } finally { await release(); root.remove(); }
});

function moduleRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object');
  return Object.fromEntries(Object.entries(value));
}
for (const cleanupFailure of [false, true]) {
  test(`首次render同步抛错清理真实React根，保留原错误${cleanupFailure ? '及清理错误' : ''}`, async () => {
    const publicUrl = new URL('../src/app/public-ui.ts', import.meta.url).href + `?portal-failure-${cleanupFailure}`;
    const mockUrl = `deviceforge-portal-test:react-root-${cleanupFailure}`;
    const clientUrl = import.meta.resolve('react-dom/client');
    const fault = registerHooks({
      resolve(specifier, context, next) {
        return specifier === 'react-dom/client' && context.parentURL === publicUrl
          ? { url: mockUrl, shortCircuit: true } : next(specifier, context);
      },
      load(url, context, next) {
        if (url !== mockUrl) return next(url, context);
        return {
          format: 'module', shortCircuit: true,
          source: [
            `import * as original from ${JSON.stringify(clientUrl)};`,
            `export * from ${JSON.stringify(clientUrl)};`,
            'export const failure = new Error("测试注入的同步render失败");',
            'export const cleanupFailure = new Error("测试注入的根清理失败");',
            'export const state = { unmounts: 0 };',
            'export function createRoot(element) {',
            '  const actual = original.createRoot(element);',
            '  return {',
            '    render(children) { actual.render(children); throw failure; },',
            '    unmount() { state.unmounts++; actual.unmount();',
            cleanupFailure ? '      throw cleanupFailure;' : '',
            '    },',
            '  };',
            '}',
          ].join('\n'),
        };
      },
    });
    const root = anchor();
    let uninstall = () => {};
    try {
      const failedModule: unknown = await import(publicUrl);
      const install = moduleRecord(failedModule).installPublicUi;
      assert.ok(typeof install === 'function');
      const target: HostUiHolder = {};
      const released: unknown = Reflect.apply(install, undefined, [target]);
      assert.ok(typeof released === 'function');
      uninstall = () => { Reflect.apply(released, undefined, []); };
      const mock: unknown = await import(mockUrl);
      const fixture = moduleRecord(mock);
      const brokenUi = target.__DEVICEFORGE_HOST_UI__;
      assert.ok(brokenUi);
      await act(async () => {
        assert.throws(() => brokenUi.mountReact(root, createElement(DialogShell, {
          open: true, onOpenChange() {}, title: '失败后不遗留确认框',
        })), (error: unknown) => {
          if (!cleanupFailure) return error === fixture.failure;
          return error instanceof AggregateError && error.cause === fixture.failure &&
            error.errors[0] === fixture.failure && error.errors[1] === fixture.cleanupFailure;
        });
      });
      assert.equal(moduleRecord(fixture.state).unmounts, 1);
      assert.equal(root.childElementCount, 0);
      assert.equal(document.querySelector('[data-slot="dialog-content"]'), null);
      const release = await mount(root, createElement('span', null, '同容器重新挂载'));
      assert.equal(root.textContent, '同容器重新挂载');
      await release();
    } finally { uninstall(); fault.deregister(); root.remove(); }
  });
}
