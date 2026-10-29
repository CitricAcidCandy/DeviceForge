import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createElement } from 'react';
import type { DebuggerController, DebuggerState } from '../../examples/browser-debugger/src/controller.ts';
import type { DataSnapshot, DataSourceInfo } from '../../examples/browser-debugger/src/protocol.ts';
import ts from 'typescript';

const loader = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'react' || specifier.startsWith('react/')) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
  return nextResolve(specifier, context);
}, load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.tsx')) return { shortCircuit: true, format: 'module', source:
    ts.transpileModule(readFileSync(new URL(url), 'utf8'), { fileName: url, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText };
  return nextLoad(url, context);
} });
const { DataView } = await import('../../examples/browser-debugger/src/data-view.tsx');
const { DebuggerApp } = await import('../../examples/browser-debugger/src/view.tsx');
const { createDebuggerController } = await import('../../examples/browser-debugger/src/controller.ts');
test.after(() => loader.deregister());

test('数据修订冲突保留用户草稿，读取最新值只进入比较且不会自动写回', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'https://example.invalid/' });
  const document = dom.window.document;
  const globals: Readonly<Record<string, unknown>> = { window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const source: DataSourceInfo = { id: 'settings', label: '别名设置', schema: { type: 'object', required: ['prefix'],
    properties: { prefix: { type: 'string', title: '名称前缀' } }, additionalProperties: false }, schemaComplete: true,
    omittedSchemaPaths: [], writable: true, persistence: 'persistent', applyPolicy: 'next_invocation' };
  const snapshot: DataSnapshot = { sourceId: 'settings', revision: 'r1', value: { prefix: '工作-' }, writable: true,
    applyPolicy: 'next_invocation', runtimeApplied: null };
  let state = { sessionId: 'session-1', stale: false, connected: true, busy: null, dataSources: [source], dataSnapshot: snapshot,
    dataConflict: false, dataNotice: null } as unknown as DebuggerState;
  let writes = 0, reads = 0;
  const controller = {
    snapshot: () => state,
    refreshDataSources: async () => {},
    readDataSource: async () => { reads++; },
    writeDataSource: async () => { writes++; },
  } as unknown as DebuggerController;
  const root = document.querySelector('#root'); assert.ok(root);
  const { createRoot } = await import('react-dom/client');
  const viewRoot = createRoot(root);
  try {
    await act(async () => { viewRoot.render(createElement(DataView, { state, controller, narrow: false })); });
    const sourceButton = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('别名设置')); assert.ok(sourceButton);
    await act(async () => sourceButton.click());
    const field = document.querySelector('input:not([type="checkbox"])'); assert.ok(field instanceof dom.window.HTMLInputElement);
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value'); assert.ok(descriptor?.set);
      descriptor.set.call(field, '用户编辑-');
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    state = { ...state, dataSnapshot: { ...snapshot, revision: 'r2', value: { prefix: '其他调用-' } }, dataConflict: true,
      dataNotice: '数据已发生变化；你的编辑已保留，请读取最新值并比较后再保存。' } as unknown as DebuggerState;
    await act(async () => { viewRoot.render(createElement(DataView, { state, controller, narrow: false })); });
    assert.equal(field.value, '用户编辑-', '冲突回执不能覆盖用户草稿');
    assert.match(root.textContent ?? '', /数据已发生变化/);
    const compare = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('读取最新值并比较'));
    assert.ok(compare);
    await act(async () => { compare?.click(); });
    assert.equal(reads, 2, '选择与显式读取分别调用读取，不能把读取变成保存重试');
    assert.equal(writes, 0, '冲突后未明确选择修订前不得写入');
    assert.equal(field.value, '用户编辑-');
  } finally {
    await act(async () => viewRoot.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

const editableSource: DataSourceInfo = { id: 'settings', label: '别名设置', schema: { type: 'object', required: ['prefix'],
  properties: { prefix: { type: 'string', title: '名称前缀' } }, additionalProperties: false }, schemaComplete: true,
  omittedSchemaPaths: [], writable: true, persistence: 'persistent', applyPolicy: 'next_invocation' };
const editableSnapshot: DataSnapshot = { sourceId: 'settings', revision: 'r1', value: { prefix: '工作-' }, writable: true,
  applyPolicy: 'next_invocation', runtimeApplied: null };

async function withEditingDom(run: (fixture: { dom: JSDOM; root: HTMLElement;
  render: (element: React.ReactNode) => Promise<void> }) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', {
    url: 'https://example.invalid/', pretendToBeVisual: true,
  });
  const globals: Readonly<Record<string, unknown>> = { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    Event: dom.window.Event, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = dom.window.document.querySelector<HTMLElement>('#root'); assert.ok(root);
  const { createRoot } = await import('react-dom/client');
  const viewRoot = createRoot(root);
  try { await run({ dom, root, render: async element => { await act(async () => { viewRoot.render(element); }); } }); }
  finally {
    await act(async () => viewRoot.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

async function editPrefix(dom: JSDOM, root: HTMLElement, value: string) {
  const field = root.querySelector('input:not([type="checkbox"])'); assert.ok(field instanceof dom.window.HTMLInputElement);
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value'); assert.ok(descriptor?.set);
    descriptor.set.call(field, value);
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  return field;
}

function findButton(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === label); assert.ok(button, `应显示按钮：${label}`);
  return button;
}

test('调试面板收起再展开保留未保存草稿，初始隐藏不采集数据', async () => {
  await withEditingDom(async ({ dom, root, render }) => {
    const context = { signal: new AbortController().signal };
    const base = createDebuggerController(context);
    let state: DebuggerState = { ...base.snapshot(), connected: true,
      target: { kind: 'browser', pluginId: 'app-alias', instanceId: 'instance-1', generation: 'generation-1', version: '1.0.0' }, sessionId: 'session-1',
      dataSources: [editableSource], dataSnapshot: editableSnapshot };
    const listeners = new Set<() => void>();
    const patch = (change: Partial<DebuggerState>) => { state = { ...state, ...change }; for (const listener of listeners) listener(); };
    let reads = 0, writes = 0, directories = 0;
    const controller: DebuggerController = { ...base, snapshot: () => state,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      open: async () => { patch({ open: true }); }, collapse: () => patch({ open: false }),
      refreshDataSources: async () => { directories++; }, readDataSource: async () => { reads++; },
      writeDataSource: async () => { writes++; } };
    await render(createElement(DebuggerApp, { controller, context: context as Parameters<typeof DebuggerApp>[0]['context'] }));
    const panel = root.querySelector<HTMLElement>('#deviceforge-debugger-panel'); assert.ok(panel);
    assert.equal(panel.hidden, true);
    assert.equal(reads + directories, 0, '初始只有悬浮入口，不应自动读取业务数据');
    const ball = root.querySelector<HTMLButtonElement>('button[aria-controls="deviceforge-debugger-panel"]'); assert.ok(ball);
    await act(async () => ball.click());
    await act(async () => findButton(root, '查看数据').click());
    await act(async () => findButton(root, '别名设置可修改 · 持久保存').click());
    const field = await editPrefix(dom, root, '收起后继续编辑-');
    const readCount = reads;
    const collapse = root.querySelector<HTMLButtonElement>('button[aria-label="收起调试器，保留会话"]'); assert.ok(collapse);
    await act(async () => collapse.click());
    assert.equal(panel.hidden, true);
    assert.equal(field.isConnected, true, '收起只隐藏面板，不能卸载表单');
    await act(async () => ball.click());
    assert.equal(panel.hidden, false);
    assert.equal(root.querySelector('input:not([type="checkbox"])'), field);
    assert.equal(field.value, '收起后继续编辑-');
    assert.match(root.textContent ?? '', /有未保存修改/);
    assert.equal(reads, readCount, '重新展开不能自动读取并覆盖草稿');
    assert.equal(writes, 0);
  });
});

test('切换数据源时选择继续编辑可取消切换并保留草稿', async () => {
  await withEditingDom(async ({ dom, root, render }) => {
    const base = createDebuggerController({ signal: new AbortController().signal });
    const state: DebuggerState = { ...base.snapshot(), connected: true, sessionId: 'session-1',
      dataSources: [editableSource, { ...editableSource, id: 'other-settings', label: '另一份设置' }], dataSnapshot: editableSnapshot };
    const reads: string[] = [];
    let writes = 0;
    const controller: DebuggerController = { ...base, snapshot: () => state,
      readDataSource: async sourceId => { reads.push(sourceId); }, writeDataSource: async () => { writes++; } };
    await render(createElement(DataView, { state, controller, narrow: false }));
    await act(async () => findButton(root, '别名设置可修改 · 持久保存').click());
    const field = await editPrefix(dom, root, '继续编辑-');
    await act(async () => findButton(root, '另一份设置可修改 · 持久保存').click());
    assert.match(root.textContent ?? '', /当前编辑尚未保存/);
    assert.deepEqual(reads, ['settings'], '未确认丢弃编辑前不能读取另一份源');
    await act(async () => findButton(root, '继续编辑').click());
    assert.doesNotMatch(root.textContent ?? '', /当前编辑尚未保存/);
    assert.equal(field.value, '继续编辑-');
    assert.equal(findButton(root, '别名设置可修改 · 持久保存').getAttribute('aria-pressed'), 'true');
    assert.equal(findButton(root, '另一份设置可修改 · 持久保存').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(reads, ['settings']);
    assert.equal(writes, 0);
  });
});
