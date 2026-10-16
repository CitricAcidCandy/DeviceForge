import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { ComponentProps, ComponentType } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { createProductServices } from '../src/app/product/services.ts';
import { createWebRtcMirroring } from '../src/features/mirroring-streaming/index.ts';
import type { MirroringOwnership } from '../src/features/mirroring-streaming/index.ts';
import type { MediaOwnershipControls } from '../src/pages/media/MediaOwnershipControls/index.tsx';
import type { MediaPage } from '../src/pages/media/index.tsx';
import type { SessionGateway, SessionInfo } from '../src/services/api/index.ts';
import { dom } from './dom-fixtures.ts';
import { FakeControlChannel, FakeMediaStream, FakeMediaTrack, FakeWebRtcConnection } from './webrtc-fixtures.ts';

type OwnershipProps = ComponentProps<typeof MediaOwnershipControls>;
function ownershipModule(value: unknown): value is { MediaOwnershipControls: ComponentType<OwnershipProps> } {
  return value !== null && typeof value === 'object' && 'MediaOwnershipControls' in value &&
    typeof value.MediaOwnershipControls === 'function';
}
function mediaModule(value: unknown): value is { MediaPage: ComponentType<ComponentProps<typeof MediaPage>> } {
  return value !== null && typeof value === 'object' && 'MediaPage' in value && typeof value.MediaPage === 'function';
}

const clientId = '12345678-1234-4234-8234-123456789abc';
const otherId = '12345678-1234-4234-8234-123456789def';
const signal = () => new AbortController().signal;
function ownership(patch: Partial<MirroringOwnership> = {}): MirroringOwnership {
  return { revision: 1, controlRevision: 1, clientId, ownerId: otherId, isMaster: false,
    canControl: true, hasControl: false, transitioning: false, blocked: false, requests: [], ...patch };
}

async function browserFixture(hash = '') {
  const browser = new JSDOM('<!doctype html><html><body><main id="ownership-test"></main></body></html>', {
    url: `http://localhost:5173/${hash}`, pretendToBeVisual: true,
  });
  const windowRef = browser.window;
  Object.defineProperty(windowRef.HTMLMediaElement.prototype, 'play', { configurable: true, value: async () => {} });
  Object.defineProperty(windowRef.HTMLMediaElement.prototype, 'pause', { configurable: true, value: () => {} });
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef, document: windowRef.document, navigator: windowRef.navigator,
    Element: windowRef.Element, HTMLElement: windowRef.HTMLElement, Node: windowRef.Node,
    DocumentFragment: windowRef.DocumentFragment, HTMLInputElement: windowRef.HTMLInputElement,
    HTMLFormElement: windowRef.HTMLFormElement, HTMLSelectElement: windowRef.HTMLSelectElement,
    HTMLButtonElement: windowRef.HTMLButtonElement, HTMLVideoElement: windowRef.HTMLVideoElement,
    HTMLCanvasElement: windowRef.HTMLCanvasElement, HTMLTextAreaElement: windowRef.HTMLTextAreaElement,
    Event: windowRef.Event, CustomEvent: windowRef.CustomEvent, MutationObserver: windowRef.MutationObserver,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef), RTCPeerConnection: FakeWebRtcConnection,
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const targetNode = windowRef.document.getElementById('ownership-test');
  assert.ok(targetNode);
  const target = targetNode;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  function button(label: string) {
    const node = Array.from(target.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === label);
    assert.ok(node, `缺少按钮：${label}`);
    return node;
  }
  return {
    windowRef, target, root, server, button,
    click: async (label: string) => { await act(async () => { button(label).click(); }); },
    async close() {
      await act(async () => { root.unmount(); });
      await server.close();
      browser.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('控制权界面实际点击申请、同意、拒绝、抢回和释放，只读与未就绪状态禁用动作', async () => {
  const browser = await browserFixture();
  const loaded: unknown = await browser.server.ssrLoadModule('/src/pages/media/MediaOwnershipControls/index.tsx');
  assert.ok(ownershipModule(loaded));
  const calls: { type: string; clientId?: string; accept?: boolean; signal: AbortSignal }[] = [];
  const accepted = async () => ({ data: { id: 'session', accepted: true }, logId: null });
  const actions: OwnershipProps['actions'] = {
    requestControl: async (signal) => { calls.push({ type: 'request', signal }); return accepted(); },
    respondControl: async (clientId, accept, signal) => {
      calls.push({ type: 'respond', clientId, accept, signal });
      return accepted();
    },
    reclaimControl: async (signal) => { calls.push({ type: 'reclaim', signal }); return accepted(); },
    releaseControl: async (signal) => { calls.push({ type: 'release', signal }); return accepted(); },
  };
  const render = async (state: MirroringOwnership | null, ready = true) => {
    await act(async () => { browser.root.render(createElement(loaded.MediaOwnershipControls, { state, ready, actions })); });
  };
  try {
    await render(null);
    assert.match(browser.target.textContent ?? '', /正在确认设备控制权/);
    assert.equal(browser.target.querySelectorAll('button').length, 0);
    await render(ownership());
    await browser.click('申请接管');
    assert.equal(calls.at(-1)?.type, 'request');
    assert.equal(calls.at(-1)?.signal.aborted, false);
    await render(ownership({ requests: [{ clientId, isMaster: false }] }));
    assert.equal(browser.button('等待接管批准').disabled, true);
    await render(ownership({ ownerId: clientId, hasControl: true,
      requests: [{ clientId: otherId, isMaster: false }] }));
    await browser.click('同意');
    assert.deepEqual({ type: calls.at(-1)?.type, clientId: calls.at(-1)?.clientId, accept: calls.at(-1)?.accept },
      { type: 'respond', clientId: otherId, accept: true });
    await browser.click('拒绝');
    assert.equal(calls.at(-1)?.accept, false);
    await browser.click('释放控制权');
    assert.equal(calls.at(-1)?.type, 'release');
    await render(ownership({ isMaster: true, blocked: true }));
    assert.equal(browser.button('申请接管').disabled, true);
    assert.equal(browser.button('主控抢回').disabled, false);
    await browser.click('主控抢回');
    assert.equal(calls.at(-1)?.type, 'reclaim');
    await render(ownership({ isMaster: true }), false);
    assert.equal(browser.button('申请接管').disabled, true);
    assert.equal(browser.button('主控抢回').disabled, true);
    const before = calls.length;
    await browser.click('申请接管');
    await browser.click('主控抢回');
    assert.equal(calls.length, before);
    await render(ownership({ canControl: false }));
    assert.equal(browser.target.querySelectorAll('button').length, 0);
    assert.match(browser.target.textContent ?? '', /只读观看/);
  } finally {
    await browser.close();
  }
});

test('真实媒体页从未知到接管再失权时禁用触摸键盘粘贴，视频保留且原生复制只写当前控制者', async () => {
  const browser = await browserFixture('#media?share_device=emulator-test&share_control=1');
  const loaded: unknown = await browser.server.ssrLoadModule('/src/pages/media/index.tsx');
  assert.ok(mediaModule(loaded));
  const writes: string[] = [];
  Object.defineProperty(browser.windowRef.navigator, 'clipboard', { configurable: true,
    value: { writeText: async (text: string) => { writes.push(text); } } });
  const sessionId = '12345678-1234-4234-8234-123456789012';
  const operation = 'plugin.mirroring.open_webrtc';
  const info = (status: SessionInfo['status'] = 'running', outputSequence = 0): SessionInfo => ({
    id: sessionId, operation, plugin_id: 'mirroring', generation: 'generation-ownership', created_at: 1,
    status, output_sequence: outputSequence,
    ...(status === 'finished' ? { completion: { cleanup: 'complete' as const, process_exited: true } } : {}),
  });
  const offer = [...new TextEncoder().encode([
    JSON.stringify({ version: 1, epoch: 1, type: 'offer', sdp: 'offer' }),
    JSON.stringify({ version: 1, epoch: 1, type: 'status', state: 'streaming' }), '',
  ].join('\n'))];
  const gateway: SessionGateway = {
    definitions: async () => ({ data: { revision: 1, sessions: [{ id: operation, title: 'WebRTC 投屏',
      input_schema: { type: 'object' }, execution: { api_version: 1, source: 'declared', total_timeout_ms: 3600000 },
    }] }, logId: null }),
    list: async () => ({ data: [], logId: null }),
    open: async () => ({ data: info(), logId: null }),
    get: async () => ({ data: info('finished'), logId: null }),
    output: async (_id, query) => ({ data: { session: info('running', 1), next_sequence: 1,
      chunks: query.after === 0 ? [{ sequence: 1, stream: 'stdout', bytes: offer }] : [] }, logId: null }),
    send: async () => ({ data: { id: sessionId, accepted: true }, logId: null }),
    eof: async () => ({ data: { id: sessionId, accepted: true }, logId: null }),
    cancel: async () => ({ data: info('stopping'), logId: null }),
    release: async () => ({ data: info('finished'), logId: null }),
    remove: async () => ({ data: { id: sessionId }, logId: null }),
  };
  const channel = new FakeControlChannel();
  const mirror = createWebRtcMirroring(gateway, {
    connectionFactory: () => {
      const connection = new FakeWebRtcConnection();
      connection.setLocalDescription = async () => {
        queueMicrotask(() => {
          connection.emitTrack(new FakeMediaTrack());
          connection.emitChannel(channel);
          channel.readyState = 'open';
          channel.changed();
          connection.setState('connected');
        });
      };
      return connection;
    },
    mediaStreamFactory: () => new FakeMediaStream(),
  });
  const services = createProductServices({ baseUrl: 'http://localhost:7031', panelTarget: () => dom(),
    transport: async () => { throw new Error('受控媒体页不应发起额外 HTTP 请求'); } });
  services.mediaDisplay.videoSize = () => ({ width: 720, height: 1280 });
  const pageServices = { ...services, webRtcMirroring: mirror };
  const state = (revision: number, hasControl: boolean) => JSON.stringify({ version: 1, type: 'control_state',
    epoch: 1, revision, control_revision: revision, client_id: clientId,
    owner_id: hasControl ? clientId : otherId, is_master: false, can_control: true,
    has_control: hasControl, transitioning: false, blocked: false, requests: [] });
  const nativeCopy = (revision: number, sequence: number, text: string) => JSON.stringify({ version: 1,
    type: 'clipboard', epoch: 1, control_revision: revision, sequence, part: 0, total: 1, text });
  try {
    await act(async () => {
      browser.root.render(createElement(loaded.MediaPage, { services: pageServices, active: true }));
    });
    assert.equal(mirror.snapshot().opening, false);
    assert.equal(mirror.snapshot().status, 'streaming', JSON.stringify({
      session: mirror.snapshot().session?.status, opening: mirror.snapshot().opening,
      errors: Object.fromEntries(Object.entries(mirror.snapshot().errors).map(([key, error]) => [key, error.code])),
    }));
    const video = browser.target.querySelector('video[aria-label="设备 WebRTC 实时投屏画面"]');
    assert.ok(video instanceof browser.windowRef.HTMLVideoElement);
    await act(async () => { video.dispatchEvent(new browser.windowRef.Event('loadedmetadata')); });
    assert.equal(browser.button('返回').disabled, true);
    assert.equal(video.tabIndex, -1);
    assert.equal(video.hidden, false);
    assert.equal(video.srcObject, mirror.snapshot().stream);
    await act(async () => { channel.emitMessage(state(1, true)); });
    assert.equal(browser.button('返回').disabled, false);
    assert.equal(browser.button('复制设备选中文本').disabled, false);
    assert.equal(video.tabIndex, 0);
    await browser.click('返回');
    assert.equal(channel.sent.length, 2);
    await act(async () => {
      channel.emitMessage(nativeCopy(1, 1, '当前控制者在原生菜单复制'));
    });
    assert.deepEqual(writes, ['当前控制者在原生菜单复制']);
    const beforeLoss = channel.sent.length;
    await act(async () => { channel.emitMessage(state(2, false)); });
    assert.equal(browser.button('返回').disabled, true);
    assert.equal(browser.button('复制设备选中文本').disabled, true);
    assert.equal(browser.button('复制到电脑').disabled, true);
    assert.equal(video.tabIndex, -1);
    assert.equal(video.hidden, false);
    assert.equal(video.srcObject, mirror.snapshot().stream);
    const clipboard = browser.target.querySelector('textarea[aria-label="设备剪贴板文本"]');
    assert.ok(clipboard instanceof browser.windowRef.HTMLTextAreaElement);
    assert.equal(clipboard.value, '');
    await browser.click('返回');
    await browser.click('复制设备选中文本');
    await act(async () => {
      video.dispatchEvent(new browser.windowRef.MouseEvent('pointerdown', { bubbles: true, buttons: 1 }));
      video.dispatchEvent(new browser.windowRef.KeyboardEvent('keydown', { bubbles: true, code: 'KeyA', key: 'a' }));
      const paste = new browser.windowRef.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { types: ['text/plain'], getData: () => '失权粘贴' } });
      video.dispatchEvent(paste);
      channel.emitMessage(nativeCopy(1, 2, '失权后的旧正文'));
      channel.emitMessage(nativeCopy(2, 3, '他人控制时正文'));
    });
    assert.equal(channel.sent.length, beforeLoss);
    assert.deepEqual(writes, ['当前控制者在原生菜单复制']);
    assert.equal(clipboard.value, '');
    assert.equal(mirror.snapshot().stream?.getVideoTracks().length, 1);
    await browser.click('申请接管');
    const request: unknown = JSON.parse(channel.sent.at(-1) ?? '');
    assert.ok(request !== null && typeof request === 'object' && 'request_id' in request &&
      typeof request.request_id === 'string' && 'type' in request && request.type === 'control_request');
    assert.equal(browser.button('申请接管').disabled, true);
    await act(async () => {
      channel.emitMessage(JSON.stringify({ version: 1, epoch: 1, type: 'control_result',
        request_id: request.request_id, ok: true }));
    });
    assert.equal(browser.button('申请接管').disabled, false);
  } finally {
    await browser.close();
    await mirror.dispose();
    await services.dispose();
  }
});
