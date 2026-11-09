import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { workspacePluginPackages } from '../scripts/workspace-plugin-packages.ts';
import { directory } from './device-fixtures.ts';
import { requestUrl, signal, success } from './fixtures.ts';

const browser = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:5173/#/devices', pretendToBeVisual: true,
});
const globals: Readonly<Record<string, unknown>> = {
  window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
  Element: browser.window.Element, HTMLElement: browser.window.HTMLElement, Node: browser.window.Node,
  DocumentFragment: browser.window.DocumentFragment, MutationObserver: browser.window.MutationObserver,
  HTMLInputElement: browser.window.HTMLInputElement, HTMLFormElement: browser.window.HTMLFormElement,
  HTMLSelectElement: browser.window.HTMLSelectElement, HTMLButtonElement: browser.window.HTMLButtonElement,
  HTMLCanvasElement: browser.window.HTMLCanvasElement, HTMLVideoElement: browser.window.HTMLVideoElement,
  HTMLTextAreaElement: browser.window.HTMLTextAreaElement,
  Event: browser.window.Event, CustomEvent: browser.window.CustomEvent,
  localStorage: browser.window.localStorage,
  getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
  requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
  cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window),
  RTCPeerConnection: class {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
Object.defineProperty(browser.window.HTMLMediaElement.prototype, 'pause', { configurable: true, value() {} });
const aliases = new Map(workspacePluginPackages(resolve(import.meta.dirname, '..')).aliases.map((item) => [item.find, item.replacement]));
aliases.set('@deviceforge/plugin-sdk', resolve(import.meta.dirname, '../src/plugin-sdk/index.ts'));
const loader = registerHooks({
  resolve(specifier, context, next) {
    const path = aliases.get(specifier);
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
    if (url.startsWith('file:') && new URL(url).pathname.endsWith('.tsx')) return {
      shortCircuit: true, format: 'module',
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: url, compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText,
    };
    return next(url, context);
  },
});
const { createRoot } = await import('react-dom/client');
const { createProductServices } = await import('../src/app/product/services.ts');
const { DeviceScreen } = await import('../src/pages/devices/screen/index.tsx');
const { FPS_STORAGE_KEY } = await import('../src/pages/devices/screen/preferences.ts');
const operation = 'plugin.mirroring.open_webrtc';
const firstLog = '12345678-1234-4234-8234-123456789abc';
const nextLog = '12345678-1234-4234-8234-123456789def';

async function fixture(fps: string) {
  browser.window.localStorage.clear();
  browser.window.localStorage.setItem(FPS_STORAGE_KEY, fps);
  const original = directory('android-device', 'provider-one', ['emulator-feedback']);
  const observed = { ...original, provider: { ...original.provider, definition: {
    ...original.provider.definition,
    capabilities: [{ id: 'read', version: 1, operation: 'plugin.android-device.read', scope: 'device', access: 'read' }],
  } } };
  const submissions: unknown[] = [];
  const requests: string[] = [];
  const services = createProductServices({
    baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      requests.push(path);
      if (path === '/api/v2/device-providers') return success([observed.provider]);
      if (path === '/api/v2/devices') return success([observed]);
      if (path === '/api/v2/session-definitions') return success({ revision: 1, sessions: [{
        id: operation, title: '受控投屏', input_schema: { type: 'object' },
        execution: { api_version: 1, source: 'declared', total_timeout_ms: 3600000 },
      }] });
      if (path === '/api/v2/plugins/mirroring/recovery') return success({
        id: 'mirroring', generation: 'mirror-one', supported: true,
        cleanup_failed: false, recovering: false, last_report: null,
      });
      if (path === '/api/v2/sessions' && init?.method === 'POST') {
        assert.equal(typeof init.body, 'string');
        if (typeof init.body !== 'string') throw new Error('受控提交缺少 JSON');
        const submitted: unknown = JSON.parse(init.body);
        submissions.push(submitted);
        const logId = submissions.length === 1 ? firstLog : nextLog;
        return Response.json({ log_id: logId, error: {
          code: 'controlled_open_failure', message: '受控投屏打开失败',
        } }, { status: 503, headers: { 'x-deviceforge-log-id': logId } });
      }
      throw new Error(`本单元不允许其他请求：${path}`);
    },
  });
  await services.runtime.devices.refreshProviders(signal());
  await services.runtime.devices.refreshDirectories(signal());
  services.runtime.devices.select({ providerId: observed.provider.id,
    generation: observed.provider.generation, localId: 'emulator-feedback' });
  const target = browser.window.document.createElement('div');
  browser.window.document.body.append(target);
  const root = createRoot(target);
  await act(async () => { root.render(createElement(DeviceScreen, {
    services, active: true, applicationPane: false,
  })); });
  function start() {
    const button = Array.from(target.querySelectorAll('button'))
      .find((item) => item.textContent?.trim() === '开始投屏');
    assert.ok(button, '需要真实开始投屏按钮');
    return button;
  }
  function frameRate() {
    const inputs = Array.from(target.querySelectorAll('input'));
    const input = inputs.find((item) => {
      const label = item.id ? target.querySelector(`label[for="${item.id}"]`) : null;
      return label?.textContent?.trim() === '帧率上限';
    });
    assert.ok(input, '需要真实帧率输入');
    return input;
  }
  return {
    target, services, submissions, requests, start, frameRate,
    async clickStart() { await act(async () => { start().click(); }); },
    async setFps(value: string) {
      const input = frameRate();
      const setValue = Object.getOwnPropertyDescriptor(browser.window.HTMLInputElement.prototype, 'value')?.set;
      assert.ok(setValue);
      await act(async () => {
        setValue.call(input, value);
        input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
      });
    },
    async close() {
      await act(async () => { root.unmount(); });
      await services.dispose();
      target.remove();
      browser.window.localStorage.clear();
    },
  };
}

after(() => {
  loader.deregister();
  browser.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('投屏开始反馈：旧帧率超出契约时就地显示失败，不创建会话或重放', async () => {
  const f = await fixture('120');
  try {
    assert.equal(f.frameRate().value, '120', '保留原输入，不能悄悄伪装成另一帧率');
    assert.equal(f.start().disabled, false);
    await f.clickStart();
    assert.equal(f.submissions.length, 0);
    assert.match(f.target.textContent ?? '', /帧率.*(?:60|无效)|投屏直播设备或编码、控制、重连参数无效/,
      '没有全局消息提供者时，失败也必须在开始入口附近可见');
    assert.equal(f.frameRate().max, '60');
    assert.equal(f.frameRate().value, '120');
    await act(async () => { await Promise.resolve(); });
    assert.equal(f.submissions.length, 0);
  } finally { await f.close(); }
});

test('投屏开始反馈：打开失败显示真实日志，修改帧率后仅显式新提交一次', async () => {
  const f = await fixture('30');
  try {
    await f.clickStart();
    assert.equal(f.submissions.length, 1);
    assert.match(f.target.textContent ?? '', /受控投屏打开失败/);
    assert.match(f.target.textContent ?? '', new RegExp(firstLog));
    assert.equal(f.start().disabled, false, '既有失败不能冻结独立新尝试');
    await f.setFps('60');
    assert.equal(f.frameRate().value, '60');
    await act(async () => { await Promise.resolve(); });
    assert.equal(f.submissions.length, 1, '改参数不能自动重试');
    await f.clickStart();
    assert.equal(f.submissions.length, 2);
    assert.deepEqual(f.submissions[1], { operation, input: {
      device_id: 'emulator-feedback', max_size: 1280, max_fps: 60,
      audio: false, control: false, clipboard_autosync: false,
    } });
    assert.match(f.target.textContent ?? '', /受控投屏打开失败/);
    assert.match(f.target.textContent ?? '', new RegExp(nextLog));
  } finally { await f.close(); }
});
