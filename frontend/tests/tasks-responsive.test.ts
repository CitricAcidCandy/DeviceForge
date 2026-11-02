import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { compile } from 'tailwindcss';
import type { HistoricalJob, HostContext } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

test('独立任务插件按容器改为单列但保留列表和明细，重排不重建查询或派发业务', async () => {
  const imports = registerCompositionStartupImports();
  const page = new JSDOM('<main></main>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const w = page.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement,
    HTMLInputElement: w.HTMLInputElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver,
    DocumentFragment: w.DocumentFragment, getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const owner = new AbortController(), calls: string[] = [];
  const job: HistoricalJob = { id: 'b6cd29a0-7577-494e-a690-dfffd9e4bd48', operation: 'plugin.fixture.read',
    status: 'succeeded', result: null, error: null, input: {}, createdAt: 1_792_000_000_000 };
  const forbidden = async (): Promise<never> => { calls.push('forbidden'); throw new Error('只读任务界面不允许派发业务'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, submit: forbidden, getJob: forbidden, cancelJob: forbidden,
    listOperations: forbidden, subscribeOperations: () => () => {}, onDispose: (release) => release,
    taskHistory: {
      list: async () => { calls.push('list'); return { data: [job], logId: null }; },
      get: async (id) => { assert.equal(id, job.id); calls.push('get'); return { data: job, logId: null }; },
      events: async (id) => { assert.equal(id, job.id); calls.push('events'); return { data: [], logId: null }; },
    },
  };
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const removeUi = installPublicUi();
  const { TasksPluginPage } = await import('../plugins/tasks/src/view.tsx');
  const { createRoot } = await import('react-dom/client');
  const target = w.document.querySelector('main'); assert.ok(target);
  const root = createRoot(target);
  try {
    await act(async () => { root.render(createElement(TasksPluginPage, { context })); });
    const view = target.querySelector('[data-product-page="tasks"]'); assert.ok(view);
    for (const name of ['@container/tasks', 'h-full', 'min-h-0', 'min-w-0', 'overflow-y-auto'])
      assert.ok(view.classList.contains(name), `缺少任务容器规则：${name}`);
    assert.equal(view.querySelector('h1')?.textContent?.trim(), '任务与日志');
    const content = view.querySelector('[data-tasks-content]'); assert.ok(content);
    assert.ok(content.classList.contains('min-h-[480px]'));
    assert.ok(content.classList.contains('@min-[900px]/tasks:flex-row'));
    assert.equal(content.classList.contains('lg:flex-row'), false);
    assert.ok(content.firstElementChild?.classList.contains('min-w-0'));
    assert.ok(view.querySelector('[aria-label="状态筛选"]'));
    const input = view.querySelector('input[aria-label="按操作名、任务 ID 或日志 ID 查询"]'); assert.ok(input);
    const task = view.querySelector<HTMLButtonElement>(`button[title="${job.id}"]`); assert.ok(task);
    await act(async () => { task.click(); });
    const details = view.querySelector('[aria-label="任务明细"]'); assert.ok(details);
    assert.ok(details.classList.contains('min-w-0')); assert.match(details.textContent ?? '', /plugin.fixture.read/);
    assert.equal(view.querySelector('input'), input); assert.equal(target.querySelector('[data-product-page="tasks"]'), view);
    assert.deepEqual(calls, ['list', 'get', 'events']);
    const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
    const css = compiler.build([...content.classList]);
    assert.match(css, /@container tasks \(width >= 900px\)/); assert.doesNotMatch(css, /@media/);
  } finally {
    await act(async () => { root.unmount(); }); owner.abort(); await removeUi(); imports.dispose(); page.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
