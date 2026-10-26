import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { createProductServices } from '../src/app/product/services.ts';
import type { PerformanceSession } from '../src/features/performance/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { directory } from './device-fixtures.ts';
import { requestUrl, signal, success } from './fixtures.ts';

const reference = { providerId: 'android-device', generation: 'g1', localId: 'phone' };
const operation = 'plugin.android-device.screenshot';
const session: PerformanceSession = {
  id: 'performance-1', revision: 1, state: 'running', samples: 0,
  request: { target: { device_id: reference.localId, package: 'example.app' }, interval_ms: 50, duration_secs: 60 },
  source: {
    device: { provider_id: reference.providerId, generation: reference.generation, local_id: reference.localId },
    plugin_id: reference.providerId, generation: reference.generation, operation: 'performance.start',
  },
  started_at: 1000, updated_at: 1000, error: null,
};

test('截图 hook 保留未确认错误，能力与会话恢复不自动重交，用户仍可显式重试（无服务）', async (t) => {
  const loader = registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && url.endsWith('.tsx')) return {
        shortCircuit: true, format: 'module',
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          fileName: url,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        }).outputText,
      };
      if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
      return nextLoad(url, context);
    },
  });
  const browser = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost/' });
  const globals: Readonly<Record<string, unknown>> = {
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const { createRoot } = await import('react-dom/client');
    const { useLiveFrames } = await import('../src/pages/performance/hooks/useLiveFrames.ts');
    for (const mode of ['submit', 'cancel'] as const) await t.test(mode, async () => {
      const base = directory(reference.providerId, reference.generation, [reference.localId]);
      const provider = { ...base.provider, definition: { ...base.provider.definition, capabilities: [{
        id: 'screenshot', version: 1, operation, scope: 'device' as const, access: 'write' as const,
      }] } };
      const observed = { ...base, provider, devices: base.devices.map((device) => ({
        ...device, capabilities: [{ id: 'screenshot', version: 1, available: true, reason: null }],
      })) };
      let submissions = 0;
      const services = createProductServices({
        baseUrl: 'http://localhost:7031', panelTarget: () => null,
        transport: async (input) => {
          const path = requestUrl(input).pathname;
          if (path.endsWith('/operations')) return success([{ id: operation, title: '截图', input_schema: {} }]);
          if (path.endsWith('/device-providers')) return success([provider]);
          if (path.endsWith('/devices')) return success([observed]);
          if (path.endsWith('/device-actions')) {
            submissions++;
            if (mode === 'submit') throw new TypeError('提交网络中断');
            return success({ id: 'shot-1', operation, input: {}, created_at: 1000, status: 'running', result: null, error: null }, 'submit-log');
          }
          if (path.includes('/jobs/shot-1')) throw new TypeError('任务网络中断');
          throw new Error(`未预期请求：${path}`);
        },
      });
      const target = browser.window.document.querySelector('main');
      assert.ok(target);
      const root = createRoot(target);
      let latest: ReturnType<typeof useLiveFrames> | undefined;
      function Probe({ live = true, reconcile = false, enabled = true, running = true }) {
        latest = useLiveFrames(services, { ...session, state: running ? 'running' : 'paused' }, enabled, live, reconcile);
        return null;
      }
      const snapshot = () => { assert.ok(latest); return latest; };
      async function failed() {
        for (let attempt = 0; attempt < 200 && (snapshot().pending || !snapshot().error); attempt++)
          await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 5)); });
        const error = snapshot().error;
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, mode === 'submit' ? 'frame_submission_unconfirmed' : 'frame_cancel_unconfirmed');
        assert.equal(snapshot().limit, null);
        assert.equal(snapshot().active, false);
        return error;
      }
      try {
        await services.runtime.operations.refresh(signal());
        await services.runtime.devices.refreshDirectories(signal());
        await services.runtime.devices.select(reference);
        await act(async () => { root.render(createElement(Probe, {})); });
        const original = await failed();
        assert.equal(submissions, 1);
        for (const props of [{ live: false }, {}, { reconcile: true }, {}, { enabled: false }, {}, { running: false }, {}])
          await act(async () => { root.render(createElement(Probe, props)); });
        await act(async () => { await services.runtime.devices.select(null); });
        await act(async () => { await services.runtime.devices.select(reference); });
        assert.equal(submissions, 1, '能力、会话及开关恢复不能自动重交未知结果');
        assert.equal(snapshot().error, original);
        await act(async () => { snapshot().retry(); snapshot().retry(); });
        await failed();
        assert.equal(submissions, 2, '显式重试只提交一次且不绕过在途串行');
      } finally {
        await act(async () => { root.unmount(); });
        await services.dispose();
      }
    });
  } finally {
    browser.window.close();
    loader.deregister();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
