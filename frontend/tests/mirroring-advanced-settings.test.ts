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
import type { AdvancedMirroringDraft } from '../src/pages/devices/screen/advanced-settings.ts';
import { directory } from './device-fixtures.ts';
import { requestUrl, signal, success } from './fixtures.ts';
import { FakeMediaStream, FakeMediaTrack } from './webrtc-fixtures.ts';

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
Object.defineProperty(browser.window.HTMLMediaElement.prototype, 'play', { configurable: true, value: async () => {} });
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
const { ApiError } = await import('../src/services/api/index.ts');
const { defaultAdvancedMirroringSettings, resolveAdvancedMirroringSettings } =
  await import('../src/pages/devices/screen/advanced-settings.ts');
const webOperation = 'plugin.mirroring.open_webrtc';
const legacyOperation = 'plugin.mirroring.open';
const failureLog = '12345678-1234-4234-8234-123456789abc';

async function fixture(initialWebRtc = true,
  configure?: (services: ReturnType<typeof createProductServices>) => void) {
  browser.window.localStorage.clear();
  let webRtc = initialWebRtc;
  const original = directory('android-device', 'provider-one', ['emulator-advanced']);
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
      if (path === '/api/v2/session-definitions') return success({ revision: 1, sessions:
        [legacyOperation, ...(webRtc ? [webOperation] : [])].map((id) => ({
          id, title: '受控投屏', input_schema: { type: 'object' },
          execution: { api_version: 1, source: 'declared', total_timeout_ms: 3600000 },
        })),
      });
      if (path === '/api/v2/plugins/mirroring/recovery') return success({
        id: 'mirroring', generation: 'mirror-one', supported: true,
        cleanup_failed: false, recovering: false, last_report: null,
      });
      if (path === '/api/v2/sessions' && init?.method === 'POST') {
        assert.equal(typeof init.body, 'string');
        if (typeof init.body !== 'string') throw new Error('受控提交缺少 JSON');
        const submitted: unknown = JSON.parse(init.body);
        submissions.push(submitted);
        return Response.json({ log_id: failureLog, error: {
          code: 'controlled_open_failure', message: '受控投屏打开失败',
        } }, { status: 503, headers: { 'x-deviceforge-log-id': failureLog } });
      }
      throw new Error(`本单元不允许其他请求：${path}`);
    },
  });
  const displayCalls: Array<Parameters<typeof services.mediaDisplay.playWebRtc>> = [];
  const playWebRtc = services.mediaDisplay.playWebRtc.bind(services.mediaDisplay);
  services.mediaDisplay.playWebRtc = (...args) => {
    displayCalls.push(args);
    return playWebRtc(...args);
  };
  await services.runtime.devices.refreshProviders(signal());
  await services.runtime.devices.refreshDirectories(signal());
  services.runtime.devices.select({ providerId: observed.provider.id,
    generation: observed.provider.generation, localId: 'emulator-advanced' });
  configure?.(services);
  const target = browser.window.document.createElement('div');
  browser.window.document.body.append(target);
  const root = createRoot(target);
  await act(async () => { root.render(createElement(DeviceScreen, {
    services, active: true, applicationPane: false,
  })); });
  function button(name: RegExp) {
    const element = Array.from(target.querySelectorAll('button'))
      .find((item) => name.test(item.textContent?.trim() ?? ''));
    assert.ok(element, `缺少按钮：${name}`);
    return element;
  }
  function name(element: Element) {
    const id = element.id;
    return element.getAttribute('aria-label') ??
      (id ? Array.from(target.querySelectorAll('label')).find((label) => label.htmlFor === id)?.textContent ?? '' : '');
  }
  function input(label: RegExp) {
    const element = Array.from(target.querySelectorAll('input')).find((item) => label.test(name(item)));
    assert.ok(element, `缺少输入：${label}`);
    return element;
  }
  function toggle(label: RegExp) {
    const element = Array.from(target.querySelectorAll('button[role="switch"], input[type="checkbox"]'))
      .find((item) => label.test(name(item)));
    assert.ok(element instanceof browser.window.HTMLButtonElement ||
      element instanceof browser.window.HTMLInputElement, `缺少开关：${label}`);
    return element;
  }
  function checked(element: Element) {
    return element instanceof browser.window.HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true';
  }
  async function fill(element: HTMLInputElement, value: string) {
    const setValue = Object.getOwnPropertyDescriptor(browser.window.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setValue);
    await act(async () => {
      setValue.call(element, value);
      element.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
    });
  }
  async function click(element: HTMLButtonElement | HTMLInputElement) {
    await act(async () => { element.click(); });
  }
  return {
    target, submissions, requests, displayCalls, button, input, toggle, checked, fill, click,
    async setWebRtc(value: boolean) {
      webRtc = value;
      await act(async () => {
        await Promise.all([services.runtime.mirroringStreaming.refreshDefinitions(signal()),
          services.webRtcMirroring.refreshDefinitions(signal())]);
      });
    },
    async close() {
      await act(async () => { root.unmount(); });
      await services.dispose();
      assert.equal(target.childElementCount, 0, '卸载撤销整个设备视图');
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

test('投屏高级设置：默认收起，展开与收起保留输入节点和草稿，不打开会话或重放播放', async () => {
  const f = await fixture();
  try {
    const trigger = f.button(/高级设置/);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await f.click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const bitRate = f.input(/码率/);
    const initialPlayback = f.displayCalls.length;
    await f.fill(bitRate, '8.5');
    await f.click(f.toggle(/音频|声音/));
    await f.click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(bitRate.isConnected, true, '收起保留同一表单节点');
    await f.click(trigger);
    assert.equal(f.input(/码率/), bitRate);
    assert.equal(bitRate.value, '8.5');
    assert.equal(f.checked(f.toggle(/音频|声音/)), true);
    assert.equal(f.submissions.length, 0);
    assert.equal(f.displayCalls.length, initialPlayback, '编辑草稿不能重放媒体');
  } finally { await f.close(); }
});

test('投屏高级设置：非法码率保留输入并提示需修正，修正后只在显式开始时提交精确参数', async () => {
  const f = await fixture();
  try {
    const trigger = f.button(/高级设置/);
    await f.click(trigger);
    const bitRate = f.input(/码率/);
    await f.fill(bitRate, '24');
    assert.equal(bitRate.value, '24');
    assert.match(f.target.textContent ?? '', /0\.128.*16|码率.*范围|码率.*超出/);
    await f.click(trigger);
    assert.match(trigger.textContent ?? '', /需修正/);
    const start = f.button(/^开始投屏$/);
    assert.equal(start.disabled, true);
    await f.click(start);
    assert.equal(f.submissions.length, 0);
    await f.click(trigger);
    assert.equal(f.input(/码率/), bitRate);
    assert.equal(bitRate.value, '24');
    await f.fill(bitRate, '8.000001');
    await f.click(f.toggle(/音频|声音/));
    assert.equal(f.submissions.length, 0);
    assert.equal(start.disabled, false);
    await f.click(start);
    assert.equal(f.submissions.length, 1);
    assert.deepEqual(f.submissions[0], { operation: webOperation, input: {
      device_id: 'emulator-advanced', max_size: 1280, max_fps: 30,
      audio: true, control: false, clipboard_autosync: false, video_bit_rate: 8000001,
    } });
    assert.match(f.target.textContent ?? '', /受控投屏打开失败/);
    assert.match(f.target.textContent ?? '', new RegExp(failureLog));
    assert.equal(bitRate.value, '8.000001');
    await act(async () => { await Promise.resolve(); });
    assert.equal(f.submissions.length, 1, '已失败的打开不能自动重放');
  } finally { await f.close(); }
});

test('投屏高级设置：只读时剪贴板不可用但保留偏好，启用控制后可独立关闭同步', async () => {
  const f = await fixture();
  try {
    await f.click(f.button(/高级设置/));
    const clipboard = f.toggle(/自动同步.*剪贴板|剪贴板.*自动同步/);
    const control = f.toggle(/^开启设备控制$/);
    assert.equal(clipboard.disabled, true);
    assert.equal(f.checked(clipboard), false, '只读时显示当前无效的同步状态');
    await f.click(control);
    assert.equal(clipboard.disabled, false);
    assert.equal(f.checked(clipboard), true);
    await f.click(clipboard);
    assert.equal(f.checked(clipboard), false);
    await f.click(control);
    assert.equal(clipboard.disabled, true);
    await f.click(control);
    assert.equal(f.checked(clipboard), false, '来回切换控制保留关闭同步的偏好');
    assert.equal(f.submissions.length, 0);
    await f.click(f.button(/^开始投屏$/));
    assert.equal(f.submissions.length, 1);
    assert.deepEqual(f.submissions[0], { operation: webOperation, input: {
      device_id: 'emulator-advanced', max_size: 1280, max_fps: 30,
      audio: false, control: true, clipboard_autosync: false,
    } });
  } finally { await f.close(); }
});

test('投屏精简设置：诊断只在连接排查详情内展开，收起不请求、不重开并保留高级草稿和日志', async () => {
  const f = await fixture();
  try {
    const visible = (element: Element) => element.closest('[hidden]') === null;
    const prose = Array.from(f.target.querySelectorAll('p')).filter(visible)
      .map((element) => element.textContent ?? '').join('\n');
    assert.doesNotMatch(prose, /长边上限，实际分辨率按设备屏幕等比缩放/,
      '常驻区域不保留已撤销的长说明');
    const textWalker = browser.window.document.createTreeWalker(f.target, browser.window.NodeFilter.SHOW_TEXT);
    let controlCaptions = 0;
    while (textWalker.nextNode()) {
      const node = textWalker.currentNode;
      if (node.parentElement && visible(node.parentElement) &&
        /^(?:开启)?设备控制$/.test(node.textContent?.trim() ?? '')) ++controlCaptions;
    }
    assert.equal(controlCaptions, 1, '同一控制开关只展示一次可见标签');
    assert.ok(f.toggle(/^开启设备控制$/), '原控制开关语义保持可操作');
    const connection = f.button(/^连接排查$/);
    assert.equal(connection.getAttribute('aria-expanded'), 'false');
    assert.equal(Array.from(f.target.querySelectorAll('button')).filter(visible)
      .some((button) => /检查直播能力|继续读取|暂停读取/.test(button.textContent ?? '')), false);
    await f.click(f.button(/高级设置/));
    const bitRate = f.input(/码率/);
    await f.fill(bitRate, '8.5');
    const before = [...f.requests];
    await f.click(connection);
    const detailId = connection.getAttribute('aria-controls');
    assert.ok(detailId, '连接排查必须指向自己的详情');
    const detail = browser.window.document.getElementById(detailId);
    assert.ok(detail && f.target.contains(detail));
    const diagnostics = detail.querySelector('[aria-label="投屏诊断操作"]');
    assert.ok(diagnostics, '诊断动作需要处于当前连接排查详情内部');
    assert.ok(Array.from(diagnostics.querySelectorAll('button'))
      .some((button) => button.textContent?.trim() === '检查直播能力'));
    assert.equal(Array.from(diagnostics.querySelectorAll('button'))
      .some((button) => /继续读取|暂停读取/.test(button.textContent ?? '')), false,
    'WebRTC 不显示不支持的兼容读取动作');
    assert.ok(Array.from(detail.querySelectorAll('button'))
      .some((button) => /核对并恢复/.test(button.textContent ?? '')));
    assert.ok(Array.from(detail.querySelectorAll('button'))
      .some((button) => button.textContent?.trim() === '读取状态'));
    await f.click(connection);
    assert.equal(connection.getAttribute('aria-expanded'), 'false');
    assert.equal(f.input(/码率/), bitRate);
    assert.equal(bitRate.value, '8.5');
    assert.deepEqual(f.requests, before, '只展开和收起不读取或提交请求');
    assert.equal(f.submissions.length, 0);
    await f.click(f.button(/^开始投屏$/));
    assert.equal(f.submissions.length, 1);
    assert.match(f.target.textContent ?? '', /受控投屏打开失败/);
    assert.match(f.target.textContent ?? '', new RegExp(failureLog));
  } finally { await f.close(); }
});

test('投屏精简设置：WebRTC 自动重连显示不支持，兼容通道保留编辑草稿且不泄漏请求', async () => {
  const f = await fixture(false);
  try {
    await f.click(f.button(/高级设置/));
    const reconnect = f.input(/重连/);
    assert.equal(reconnect.disabled || reconnect.readOnly, false);
    await f.fill(reconnect, '2');
    assert.equal(f.submissions.length, 0);
    await f.setWebRtc(true);
    assert.equal(Array.from(f.target.querySelectorAll('input'))
      .some((input) => {
        const label = Array.from(f.target.querySelectorAll('label')).find((item) => item.htmlFor === input.id);
        return /重连/.test(input.getAttribute('aria-label') ?? label?.textContent ?? '');
      }), false, 'WebRTC 不展示假的可编辑或禁用数字输入');
    const term = Array.from(f.target.querySelectorAll('dt')).find((item) => item.textContent?.trim() === '自动重连');
    assert.ok(term, '需要语义化的自动重连状态');
    assert.equal(term.nextElementSibling?.tagName, 'DD');
    assert.equal(term.nextElementSibling?.textContent?.trim(), '不支持');
    await f.setWebRtc(false);
    assert.equal(f.input(/重连/).value, '2', 'WebRTC 不清除兼容通道的草稿');
    await f.setWebRtc(true);
    await f.click(f.button(/^开始投屏$/));
    assert.equal(f.submissions.length, 1);
    assert.deepEqual(f.submissions[0], { operation: webOperation, input: {
      device_id: 'emulator-advanced', max_size: 1280, max_fps: 30,
      audio: false, control: false, clipboard_autosync: false,
    } });
    const count = f.requests.length;
    assert.equal(f.submissions.length, 1);
    await act(async () => { await Promise.resolve(); });
    assert.equal(f.requests.length, count);
  } finally { await f.close(); }
});

test('投屏高级设置规则：十进制码率与通道限制拒绝隐式钳制，保留无效草稿', () => {
  const defaults = defaultAdvancedMirroringSettings();
  assert.deepEqual(defaults, { videoBitRateMbps: '', audio: false,
    clipboardAutosync: true, reconnectAttempts: '0' });
  assert.deepEqual(resolveAdvancedMirroringSettings(defaults, { control: false, webRtc: true }), {
    input: { audio: false, clipboard_autosync: false }, errors: {},
  });
  const boundaries: readonly { readonly text: string; readonly bitRate: number }[] = [
    { text: '0.128', bitRate: 128000 }, { text: '8.000001', bitRate: 8000001 },
    { text: '16', bitRate: 16000000 },
  ];
  for (const { text, bitRate } of boundaries) {
    const result = resolveAdvancedMirroringSettings({ ...defaults, videoBitRateMbps: text }, {
      control: true, webRtc: true,
    });
    assert.equal(result.input?.video_bit_rate, bitRate);
    assert.equal(result.input?.clipboard_autosync, true);
  }
  for (const text of ['24', '1e1', '0x10', '0.127999', '16.000001', '8.0000001', '-1', 'Infinity']) {
    const draft: AdvancedMirroringDraft = { ...defaults, videoBitRateMbps: text };
    const result = resolveAdvancedMirroringSettings(draft, { control: false, webRtc: true });
    assert.equal(result.input, null, `不能把${text}钳制成有效码率`);
    assert.ok(result.errors.videoBitRateMbps);
    assert.equal(draft.videoBitRateMbps, text);
  }
  const legacyDraft = { ...defaults, reconnectAttempts: '2', audio: true };
  assert.deepEqual(resolveAdvancedMirroringSettings(legacyDraft, { control: true, webRtc: false }), {
    input: { audio: true, clipboard_autosync: true, reconnect_attempts: 2 }, errors: {},
  });
  assert.deepEqual(resolveAdvancedMirroringSettings(legacyDraft, { control: true, webRtc: true }), {
    input: { audio: true, clipboard_autosync: true }, errors: {},
  });
  assert.equal(legacyDraft.reconnectAttempts, '2');
  for (const text of ['-1', '1.5', '6', '1e0']) {
    const result = resolveAdvancedMirroringSettings({ ...defaults, reconnectAttempts: text }, {
      control: false, webRtc: false,
    });
    assert.equal(result.input, null);
    assert.ok(result.errors.reconnectAttempts);
  }
});

test('投屏高级设置声音应用：成功打开才应用声音，草稿和失败不改变已应用播放', async () => {
  const opened: Array<Parameters<ReturnType<typeof createProductServices>['webRtcMirroring']['open']>[0]> = [];
  const streams: FakeMediaStream[] = [];
  let listenersAfterClose = -1;
  const f = await fixture(true, (services) => {
    const model = services.webRtcMirroring;
    const initial = model.snapshot();
    let current = initial;
    const listeners = new Set<Parameters<typeof model.subscribe>[0]>();
    const subscribe = model.subscribe.bind(model);
    const publish = () => { for (const listener of listeners) listener(current); };
    model.snapshot = () => current;
    model.subscribe = (listener) => {
      listeners.add(listener);
      const release = subscribe((snapshot) => {
        current = { ...snapshot, session: current.session, stream: current.stream };
        listener(current);
      });
      return () => { listeners.delete(listener); release(); listenersAfterClose = listeners.size; };
    };
    // 只在公开服务边界提供成功/失败及流观测，不建立 Peer、信令或服务器会话。
    model.open = async (input, requestSignal) => {
      requestSignal.throwIfAborted();
      opened.push(structuredClone(input));
      if (opened.length === 1)
        throw new ApiError('network', 'controlled_audio_failure', '受控声音打开失败', 503, failureLog);
      const stream = new FakeMediaStream();
      stream.addTrack(new FakeMediaTrack('video'));
      stream.addTrack(new FakeMediaTrack('audio'));
      streams.push(stream);
      const identity = {
        id: '12345678-1234-4234-8234-123456789aaa',
        operation: webOperation, plugin_id: 'mirroring', generation: 'controlled-audio',
        created_at: 1, status: 'running', output_sequence: 0,
      } satisfies NonNullable<typeof current.session>;
      current = { ...current, session: identity, stream, status: 'streaming' };
      publish();
      return { data: identity, logId: failureLog };
    };
    model.release = async (requestSignal) => {
      requestSignal.throwIfAborted();
      const identity = current.session;
      if (!identity) throw new Error('受控释放需要当前会话');
      current = { ...current, session: null, stream: null, status: null };
      publish();
      return { data: { ...identity, status: 'finished' }, logId: failureLog };
    };
  });
  try {
    await f.click(f.button(/高级设置/));
    const audio = f.toggle(/音频|声音/);
    const video = f.target.querySelector('video[aria-label="设备 WebRTC 实时投屏画面"]');
    assert.ok(video instanceof browser.window.HTMLVideoElement);
    assert.equal(video.muted, true);
    await f.click(audio);
    assert.equal(video.muted, true, '尚未提交的声音草稿不能解除静音');
    const baseline = f.displayCalls.length;
    await f.click(f.button(/^开始投屏$/));
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.audio, true);
    assert.equal(video.muted, true, '失败打开不能应用声音');
    assert.equal(f.displayCalls.length, baseline);
    assert.match(f.target.textContent ?? '', /受控声音打开失败/);
    await f.click(f.button(/^开始投屏$/));
    assert.equal(opened.length, 2);
    assert.equal(opened[1]?.audio, true);
    assert.equal(video.muted, false);
    assert.equal(f.displayCalls.at(-1)?.[0], streams[0]);
    assert.equal(f.displayCalls.at(-1)?.[1], true);
    assert.equal(streams[0]?.getAudioTracks()[0]?.enabled, true);
    const playing = f.displayCalls.length;
    await f.click(audio);
    assert.equal(f.checked(audio), false);
    assert.equal(video.muted, false, '运行中修改草稿不能立即静音');
    assert.equal(opened.length, 2);
    assert.equal(f.displayCalls.length, playing);
    await f.click(f.button(/^释放直播$/));
    await f.click(f.button(/^开始投屏$/));
    assert.equal(opened.length, 3);
    assert.equal(opened[2]?.audio, false);
    assert.equal(video.muted, true, '下一次显式成功才应用关闭声音');
    assert.equal(f.displayCalls.at(-1)?.[0], streams[1]);
    assert.equal(f.displayCalls.at(-1)?.[1], false);
    assert.equal(streams[1]?.getAudioTracks()[0]?.enabled, false);
    assert.equal(f.submissions.length, 0, '受控公开边界未发起任何真实或内存 HTTP 开会话');
  } finally { await f.close(); }
  assert.equal(listenersAfterClose, 0);
});
