import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import { compile } from 'tailwindcss';
import type { HistoricalJob, HostContext } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

test('原底部任务行按公开页面归属打开抽屉，保留筛选明细复制及跨页隔离且不派发业务', async () => {
  const imports = registerCompositionStartupImports();
  const page = new JSDOM('<main></main>', { pretendToBeVisual: true, url: 'http://localhost/#/sample' });
  const w = page.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement,
    HTMLInputElement: w.HTMLInputElement, HTMLButtonElement: w.HTMLButtonElement,
    Element: w.Element, Node: w.Node, NodeFilter: w.NodeFilter, MutationObserver: w.MutationObserver,
    DocumentFragment: w.DocumentFragment, CustomEvent: w.CustomEvent,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const owner = new AbortController(), calls: string[] = [], copied: string[] = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied.push(value); } } });
  const registry = createWorkspaceRegistry();
  const ui = registry.access({ pluginId: 'sample', generation: 1, signal: owner.signal });
  ui.register({ pages: [
    { id: 'sample.page', title: '示例设备', route: '/sample', workspaceId: 'sample.workspace', operations: ['sample.read'] },
    { id: 'sample.files', title: '示例文件', route: '/files', workspaceId: 'sample.filespace', operations: ['sample.write'] },
    { id: 'sample.tasks', title: '任务与日志', route: '/tasks', workspaceId: 'sample.all', taskPolicy: 'all' },
  ] });
  const failed: HistoricalJob = { id: 'task-read', operation: 'sample.read', status: 'failed',
    result: { observed: true }, error: '读取失败', input: { source: 'sample' }, createdAt: 2 };
  const active: HistoricalJob = { ...failed, id: 'task-write', operation: 'sample.write', status: 'running', error: null };
  const forbidden = async (): Promise<never> => { calls.push('forbidden'); throw new Error('不得派发或取消业务'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, ui, onDispose: (release) => release,
    listOperations: async () => {
      calls.push('operations'); return { data: [{ id: 'sample.read', title: '读取设备', input_schema: {} }], logId: null };
    },
    subscribeOperations: () => () => {}, submit: forbidden, cancelJob: forbidden, getJob: forbidden,
    taskHistory: {
      list: async () => { calls.push('list'); return { data: [failed, active], logId: 'list-log' }; },
      get: async (id) => { calls.push(`get:${id}`); return { data: failed, logId: 'detail-log' }; },
      events: async (id) => { calls.push(`events:${id}`); return { data: [
        { jobId: id, sequence: 1, status: 'failed', timestamp: 2 },
      ], logId: 'event-log' }; },
    },
  };
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const removeUi = installPublicUi();
  const { mountTaskFooter } = await import('../plugins/tasks/src/footer.tsx');
  const target = w.document.querySelector('main'); assert.ok(target);
  let release: Awaited<ReturnType<typeof mountTaskFooter>> | null = null;
  let releaseOther: Awaited<ReturnType<typeof mountTaskFooter>> | null = null;
  try {
    await act(async () => { release = mountTaskFooter(target, context); });
    const strip = target.querySelector<HTMLButtonElement>('button[aria-label="当前页面任务"]'); assert.ok(strip);
    assert.match(strip.textContent ?? '', /空闲/); assert.match(strip.textContent ?? '', /1 失败/);
    assert.match(strip.textContent ?? '', /1 条记录/);
    assert.equal(w.document.querySelector('[role="dialog"]'), null);
    await act(async () => { strip.focus(); strip.click(); });
    const drawer = w.document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(drawer);
    assert.match(drawer.textContent ?? '', /示例设备 · 任务/);
    assert.ok(drawer.classList.contains('@container/task-drawer'));
    assert.ok(drawer.classList.contains('h-[min(48dvh,420px)]'));
    assert.equal(strip.getAttribute('aria-controls'), drawer.id);
    assert.ok(drawer.contains(w.document.activeElement));
    await act(async () => {
      w.document.activeElement?.dispatchEvent(new w.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
    });
    assert.equal(w.document.querySelector('[role="dialog"]'), null);
    assert.equal(strip.getAttribute('aria-expanded'), 'false');
    assert.ok(w.document.activeElement === strip, '关闭当前页任务后应返回原入口而非失去键盘位置');
    await act(async () => { strip.click(); });
    const reopened = w.document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(reopened);
    assert.equal(reopened.id, drawer.id);
    const close = [...reopened.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === '关闭');
    assert.ok(close);
    await act(async () => { close.click(); });
    assert.equal(w.document.querySelector('[role="dialog"]'), null);
    assert.ok(w.document.activeElement === strip, '关闭按钮同样应返回当前实例的任务入口');
    await act(async () => { strip.click(); });
    const currentDrawer = w.document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(currentDrawer);
    assert.equal(currentDrawer.querySelectorAll('[data-task-id]').length, 1);
    const row = currentDrawer.querySelector<HTMLButtonElement>('[data-task-id="task-read"] > button'); assert.ok(row);
    assert.match(row.textContent ?? '', /读取设备/);
    assert.equal(row.querySelector('[title="sample.read"]')?.getAttribute('title'), 'sample.read');
    await act(async () => { row.click(); });
    assert.match(currentDrawer.textContent ?? '', /detail-log/);
    assert.match(currentDrawer.textContent ?? '', /事件 · 1/);
    const copy = [...currentDrawer.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.includes('复制 ID'));
    assert.ok(copy); await act(async () => { copy.click(); }); assert.deepEqual(copied, ['task-read']);
    const activeFilter = currentDrawer.querySelector<HTMLButtonElement>('button[data-task-filter="active"]'); assert.ok(activeFilter);
    await act(async () => { activeFilter.click(); });
    assert.match(currentDrawer.textContent ?? '', /当前页面没有进行中的任务/);
    assert.equal(currentDrawer.querySelectorAll('[data-task-id]').length, 0);
    await act(async () => { w.location.hash = '/files'; w.dispatchEvent(new w.HashChangeEvent('hashchange')); });
    const files = w.document.querySelector('[role="dialog"]'); assert.ok(files);
    assert.match(files.textContent ?? '', /示例文件 · 任务/);
    assert.equal(files.querySelectorAll('[data-task-id="task-read"]').length, 0);
    assert.equal(files.querySelectorAll('[data-task-id="task-write"]').length, 1);
    assert.deepEqual(calls, ['list', 'operations', 'operations', 'operations', 'get:task-read', 'events:task-read', 'operations']);
    const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
    assert.match(compiler.build([...drawer.classList]), /48dvh/);
    await act(async () => { if (release) await release(); release = null; });
    assert.equal(w.document.querySelector('[role="dialog"]'), null);
    assert.equal(target.childElementCount, 0);
    await act(async () => { w.location.hash = '/sample'; w.dispatchEvent(new w.HashChangeEvent('hashchange')); });
    assert.deepEqual(calls, ['list', 'operations', 'operations', 'operations', 'get:task-read', 'events:task-read', 'operations']);
    const unavailableNames: HostContext = {
      ...context,
      listOperations: async () => { throw new Error('操作目录暂不可用'); },
      subscribeOperations: () => { throw new Error('操作目录订阅暂不可用'); },
    };
    await act(async () => { release = mountTaskFooter(target, unavailableNames); });
    const restored = target.querySelector<HTMLButtonElement>('button[aria-label="当前页面任务"]'); assert.ok(restored);
    await act(async () => { restored.click(); });
    const raw = w.document.querySelector('[role="dialog"] [data-task-id="task-read"] > button');
    assert.ok(raw); assert.match(raw.textContent ?? '', /sample\.read/);
    const otherTarget = w.document.createElement('aside');
    w.document.body.append(otherTarget);
    await act(async () => {
      w.document.activeElement?.dispatchEvent(new w.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
    });
    await act(async () => { releaseOther = mountTaskFooter(otherTarget, context); });
    const otherStrip = otherTarget.querySelector<HTMLButtonElement>('button[aria-label="当前页面任务"]');
    assert.ok(otherStrip);
    assert.notEqual(otherStrip.getAttribute('aria-controls'), restored.getAttribute('aria-controls'));
    await act(async () => { otherStrip.focus(); otherStrip.click(); });
    const otherDrawer = w.document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(otherDrawer);
    assert.equal(otherDrawer.id, otherStrip.getAttribute('aria-controls'));
    await act(async () => {
      w.document.activeElement?.dispatchEvent(new w.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
    });
    assert.equal(w.document.querySelector('[role="dialog"]'), null);
    assert.ok(w.document.activeElement === otherStrip, '第二实例关闭后不得跳回第一实例的任务入口');
    assert.equal(calls.includes('forbidden'), false);
  } finally {
    await act(async () => { if (releaseOther) await releaseOther(); if (release) await release(); });
    owner.abort(); registry.dispose(); await removeUi(); imports.dispose(); page.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
