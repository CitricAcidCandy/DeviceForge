import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { deferred, failure, job, requestUrl, success } from './fixtures.ts';
import { createProductServices } from '../src/app/product/services.ts';

registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
  if (url.startsWith('file:') && url.endsWith('.tsx')) return { shortCircuit: true, format: 'module',
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { fileName: url,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
  return next(url, context);
} });

test('任务与日志默认倒序，关键词搜索服务器且不受前端200条限制，切换顺序并撤销迟到查询', async () => {
  const browser = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const w = browser.window;
  const globals: Readonly<Record<string, unknown>> = { window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, HTMLInputElement: w.HTMLInputElement, Element: w.Element, Node: w.Node,
    Event: w.Event, CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, DocumentFragment: w.DocumentFragment,
    MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const id = 'd3be1c0c-eee8-43a6-9f47-f963ddbfc725';
  const secondId = '31a501f3-ab38-4f84-8c70-d74bf6c86520';
  const late = deferred<Response>();
  const requests: string[] = [];
  const recentJobs = Array.from({ length: 200 }, (_, index) => ({ ...job(`recent-${index}`),
    operation: 'recent.run', created_at: 1_792_000_000_000 + index * 1000, status: index === 0 ? 'running' : 'succeeded' }));
  const services = createProductServices({ baseUrl: 'http://localhost', panelTarget: () => null,
    transport: async (input, init) => {
      const url = requestUrl(input); requests.push(`${init?.method} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/jobs')) return success(recentJobs);
      if (url.pathname.endsWith('/jobs/recent-199/events')) return success([
        { job_id: 'recent-199', sequence: 1, timestamp: 1000, status: 'queued' },
        { job_id: 'recent-199', sequence: 2, timestamp: 2000, status: 'succeeded' },
      ]);
      if (url.pathname.endsWith('/jobs/recent-199')) return success(recentJobs[199]);
      if (url.pathname.includes('/jobs/')) return failure('not_found', 404);
      if (url.pathname.includes('/diagnostics/logs')) {
        if (url.searchParams.get('log_id') === secondId) return late.promise;
        if (url.searchParams.has('q')) {
          const entries = [0, 1].map((index) => ({ timestamp: `2026-10-27T10:00:0${index}Z`, level: 'INFO',
            log_id: id, message: `服务器历史日志 ${index}`, job_id: null, operation: 'app.start', code: null, method: null, route: null, status: null }));
          return success({ log_id: null, entries: url.searchParams.get('order') === 'asc' ? entries : entries.reverse(), job_ids: [], limited: false });
        }
        return success({ log_id: id, entries: [{ timestamp: '2026-10-27T10:00:00Z', level: 'INFO',
          message: '响应已建立', job_id: null, operation: null, code: null, method: 'GET', route: '/api/v2/jobs/{id}', status: 200 }],
          job_ids: [], limited: false });
      }
      return success([]);
    } });
  const { TasksPage } = await import('../src/pages/tasks/index.tsx');
  const { MessageProvider } = await import('../src/components/Message/index.tsx');
  const { createRoot } = await import('react-dom/client');
  const target = w.document.querySelector('main'); assert.ok(target);
  const root = createRoot(target);
  async function setQuery(value: string) {
    const input = target?.querySelector<HTMLInputElement>('#task-query'); assert.ok(input);
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set; assert.ok(setter);
    await act(async () => { setter.call(input, value); input.dispatchEvent(new w.Event('input', { bubbles: true })); });
    return input;
  }
  try {
    await act(async () => root.render(createElement(MessageProvider, { controller: services.messages,
      children: createElement(TasksPage, { services }) })));
    assert.equal(target.querySelector('button[title]')?.getAttribute('title'), 'recent-199');
    const task = target.querySelector<HTMLButtonElement>('button[title="recent-199"]'); assert.ok(task);
    await act(async () => task.click());
    const eventItems = () => Array.from(target.querySelectorAll('[aria-label="任务明细"] ol li')).map((entry) => entry.textContent);
    assert.match(eventItems()[0] ?? '', /成功/);
    const eventOrder = target.querySelector<HTMLButtonElement>('[aria-label="切换任务日志时间排序"]'); assert.ok(eventOrder);
    await act(async () => eventOrder.click());
    assert.match(eventItems()[0] ?? '', /排队中/);
    const orderButton = target.querySelector<HTMLButtonElement>('[aria-label="切换时间排序"]'); assert.ok(orderButton);
    assert.equal(target.querySelector('button[title]')?.getAttribute('title'), 'recent-0');
    await act(async () => orderButton.click());
    const input = await setQuery(id);
    await act(async () => input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const results = target.querySelector('[aria-label="日志查询结果"]'); assert.ok(results);
    assert.match(results.textContent ?? '', /响应已建立/);
    assert.match(results.textContent ?? '', /HTTP 200；不代表任务执行结果/);
    assert.match(results.textContent ?? '', /没有可读取的关联任务/);
    await setQuery(secondId);
    await act(async () => input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await setQuery('app.start');
    await act(async () => late.resolve(success({ log_id: secondId, entries: [], job_ids: [], limited: false })));
    assert.equal(target.querySelector('[aria-label="日志查询结果"]'), null);
    assert.equal(target.querySelectorAll('button[title]').length, 200);
    await act(async () => input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const keywordResults = target.querySelector('[aria-label="日志查询结果"]'); assert.ok(keywordResults);
    assert.match(keywordResults.textContent ?? '', /服务器搜索：app.start/);
    assert.match(keywordResults.querySelector('ol li')?.textContent ?? '', /服务器历史日志 1/);
    assert.ok(keywordResults.querySelector(`[aria-label="复制日志 ID ${id}"]`));
    const logOrder = keywordResults.querySelector<HTMLButtonElement>('[aria-label="切换请求日志时间排序"]'); assert.ok(logOrder);
    await act(async () => logOrder.click());
    assert.match(target.querySelector('[aria-label="日志查询结果"] ol li')?.textContent ?? '', /服务器历史日志 0/);
    assert.ok(requests.includes('GET /api/v2/diagnostics/logs?q=app.start&order=desc'));
    assert.ok(requests.includes('GET /api/v2/diagnostics/logs?q=app.start&order=asc'));
    assert.ok(requests.some((request) => request.includes(`log_id=${id}`)));
    assert.ok(requests.every((request) => request.startsWith('GET ')));
  } finally {
    await act(async () => root.unmount());
    await services.dispose(); browser.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
