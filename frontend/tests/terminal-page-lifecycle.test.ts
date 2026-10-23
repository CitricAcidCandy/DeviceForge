import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { createProductServices } from '../src/app/product/services.ts';
import type { ProductServices } from '../src/app/product/services.ts';
import type { SessionInfo } from '../src/services/api/index.ts';
import { deferred, requestUrl, success } from './fixtures.ts';

function pageModule(value: unknown): value is {
  TerminalPage: ComponentType<{ services: ProductServices }>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'TerminalPage' in value &&
    typeof value.TerminalPage === 'function'
  );
}

async function settled(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++)
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  assert.ok(condition(), message);
}

test('关闭返回Stopping后页面继续读取Finished，确认清理后允许新建', async () => {
  const browser = new JSDOM('<div id="terminal-lifecycle-test"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost:7031',
  });
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef,
    document: windowRef.document,
    navigator: windowRef.navigator,
    HTMLElement: windowRef.HTMLElement,
    Element: windowRef.Element,
    Node: windowRef.Node,
    DocumentFragment: windowRef.DocumentFragment,
    MutationObserver: windowRef.MutationObserver,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const firstId = '12345678-1234-1234-1234-123456789abc';
  const secondId = '22345678-1234-1234-1234-123456789abc';
  const session = (id: string): SessionInfo => ({
    id,
    operation: 'plugin.terminal.open',
    plugin_id: 'terminal',
    generation: 'terminal-generation',
    created_at: 1,
    status: 'opening',
    output_sequence: 0,
    completion: null,
  });
  let current = session(firstId);
  let opens = 0;
  let stoppingReads = 0;
  let cancelReceipt: SessionInfo['status'] | null = null;
  const removed: string[] = [];
  const runningReadSignals: (AbortSignal | null | undefined)[] = [];
  const completed = deferred<void>();
  const pending = deferred<Response>();
  const output = () =>
    success({ session: current, chunks: [], next_sequence: 0 }, 'terminal-observe-log');
  const transport: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/v2/session-definitions')
      return success({
        revision: 1,
        sessions: [{
          id: 'plugin.terminal.open', title: '终端', input_schema: { type: 'object' },
          execution: { api_version: 1, source: 'declared', total_timeout_ms: 60_000 },
        }],
      });
    if (url.pathname === '/api/v2/plugin-configurations/server/terminal')
      return success({
        kind: 'server', id: 'terminal', definition: null,
        values: { profiles: { powershell: { executable: 'fixture-shell', args: [] } } },
        revision: 0, applied_revision: 0, pending_reload: false,
        compatible: true, source: 'managed', field_errors: [],
      });
    if (url.pathname === '/api/v2/sessions') {
      if (method === 'GET') return success([]);
      opens++;
      current = session(opens === 1 ? firstId : secondId);
      return success(current, 'terminal-open-log');
    }
    if (url.pathname === `/api/v2/sessions/${current.id}/output`) {
      if (current.status === 'opening') {
        current = { ...current, status: 'running' };
        return output();
      }
      if (current.status === 'stopping') {
        stoppingReads++;
        await completed.promise;
        return output();
      }
      if (current.status === 'finished') return output();
      runningReadSignals.push(init?.signal);
      return pending.promise;
    }
    if (url.pathname === `/api/v2/sessions/${firstId}/cancel`) {
      current = { ...current, status: 'stopping' };
      cancelReceipt = current.status;
      return success(current, 'terminal-cancel-log');
    }
    if (url.pathname === `/api/v2/sessions/${firstId}` && method === 'DELETE') {
      assert.equal(current.status, 'finished');
      removed.push(firstId);
      return success({ id: firstId }, 'terminal-remove-log');
    }
    if (url.pathname.endsWith('/release'))
      return success({ ...current, status: 'stopping' }, 'terminal-release-log');
    throw new Error(`未预期请求：${method} ${url.pathname}`);
  };

  const services = createProductServices({
    baseUrl: 'http://localhost:7031',
    transport,
    panelTarget: () => windowRef.document.createElement('div'),
  });
  const server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    plugins: [{
      name: 'terminal-page-lifecycle-test-viewport',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === './TerminalViewport.tsx' && importer?.replaceAll('\\', '/').endsWith('/pages/terminal/index.tsx'))
          return '\0terminal-page-lifecycle-test-viewport';
      },
      load(id) {
        if (id === '\0terminal-page-lifecycle-test-viewport')
          return "import { createElement } from 'react'; export function TerminalViewport() { return createElement('div', { 'aria-label': '终端输出' }); }";
      },
    }],
  });
  const target = windowRef.document.getElementById('terminal-lifecycle-test');
  assert.ok(target);
  const root = createRoot(target);
  const button = (label: string) => {
    const found = Array.from(target.querySelectorAll('button')).find(
      (entry) => entry.textContent?.trim() === label,
    );
    assert.ok(found, `缺少终端操作：${label}`);
    return found;
  };
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/pages/terminal/index.tsx');
    assert.ok(pageModule(loaded));
    await act(async () => root.render(createElement(loaded.TerminalPage, { services })));
    await settled(() => !button('新会话').disabled, '终端目录和档案未就绪');
    await act(async () => button('新会话').click());
    await settled(() => runningReadSignals.length > 0, '页面没有进入运行中的输出读取');
    assert.equal(opens, 1);
    await act(async () => button('关闭会话').click());
    assert.equal(cancelReceipt, 'stopping', '关闭收据必须保留真实异步关闭状态');
    assert.ok(button('新会话').disabled, '尚未确认清理时不能打开新会话');
    assert.ok(target.querySelector('header')?.textContent?.includes('关闭中'));
    await settled(() => stoppingReads > 0, '收到Stopping后页面必须继续观察终态');
    assert.equal(runningReadSignals[0]?.aborted, true);

    await act(async () => {
      current = {
        ...current, status: 'finished',
        completion: {
          cleanup: 'complete', process_exited: true, sequence: 1,
          outcome: null, failure: null,
        },
      };
      completed.resolve();
    });
    await settled(() => !button('新会话').disabled, '确认Finished后新会话仍不可用');
    assert.ok(target.textContent?.includes('清理完成'));
    assert.ok(button('关闭会话').disabled);
    await act(async () => button('新会话').click());
    await settled(() => opens === 2, '确认终态后未能再次创建会话');
    assert.deepEqual(removed, [firstId]);
    assert.equal(services.sessions.snapshot().session?.id, secondId);
  } finally {
    completed.resolve();
    await act(async () => root.unmount());
    await services.dispose();
    pending.resolve(output());
    await server.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    browser.window.close();
  }
});
