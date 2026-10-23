import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { PluginRecoveryView } from '../src/services/api/index.ts';
import type { PluginRecoverySnapshot, RecoveryTarget } from '../src/features/plugin-recovery/index.ts';
import { createProductServices } from '../src/app/product/services.ts';
import { createMessageController } from '../src/components/Message/controller.ts';
import { directory } from './device-fixtures.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const report = (status: 'recovered' | 'blocked' | 'busy' = 'recovered'): NonNullable<PluginRecoveryView['last_report']> => ({
  status, coverage: 'plugin', inspected: 4, remaining: status === 'recovered' ? 0 : 2,
  message: status === 'recovered' ? '全部资源已确认' : '有资源仍未确认',
  checks: [{ resource: 'control', status: status === 'recovered' ? 'confirmed' : status, message: '控制通道核对结果' }],
});
const view = (patch: Partial<PluginRecoveryView> = {}): PluginRecoveryView => ({
  id: 'mirroring', generation: 'g1', supported: true, cleanup_failed: true,
  recovering: false, last_report: null, ...patch,
});
const state = (patch: Partial<PluginRecoverySnapshot> = {}): PluginRecoverySnapshot => ({
  target: { key: 'device-a:g1', deviceId: 'device-a' }, phase: 'idle', result: null,
  error: null, unavailable: false, cancelled: false, reportTarget: null, ...patch,
});

async function settled(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 30 && !condition(); ++attempt)
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
  assert.ok(condition(), message);
}

test('恢复面板与投屏页的真实 React 行为（无服务监听、无真实设备请求）', async (t) => {
  // 只在本进程编译 TSX；不启动 Vite、浏览器或后台服务器。
  const loader = registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && url.endsWith('.tsx')) return {
        shortCircuit: true, format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          fileName: url, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        }).outputText,
      };
      if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
      return nextLoad(url, context);
    },
  });
  const browser = new JSDOM('<!doctype html><html><body><main id="recovery-test"></main></body></html>', {
    url: 'http://localhost:5173/', pretendToBeVisual: true,
  });
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef, document: windowRef.document, navigator: windowRef.navigator,
    Element: windowRef.Element, HTMLElement: windowRef.HTMLElement, Node: windowRef.Node,
    DocumentFragment: windowRef.DocumentFragment, MutationObserver: windowRef.MutationObserver,
    HTMLInputElement: windowRef.HTMLInputElement, HTMLFormElement: windowRef.HTMLFormElement,
    HTMLSelectElement: windowRef.HTMLSelectElement, HTMLTextAreaElement: windowRef.HTMLTextAreaElement,
    HTMLButtonElement: windowRef.HTMLButtonElement, HTMLVideoElement: windowRef.HTMLVideoElement,
    HTMLCanvasElement: windowRef.HTMLCanvasElement, Event: windowRef.Event, CustomEvent: windowRef.CustomEvent,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const target = windowRef.document.getElementById('recovery-test');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const { RecoveryPanel, usePluginRecovery } = await import('../src/pages/devices/screen/RecoveryPanel/index.tsx');
  const { MessageProvider } = await import('../src/components/Message/index.tsx');
  const messages = createMessageController();
  const button = (label: string, within: ParentNode = target) => {
    const found = Array.from(within.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
    assert.ok(found, `缺少按钮：${label}`);
    return found;
  };
  const click = async (label: string) => { await act(async () => { button(label).click(); }); };
  const reset = async () => { await act(async () => { root.render(null); messages.clear(); }); };
  const noAction = async () => undefined;
  try {
    await t.test('手动核对可独立使用，显示全插件检查与未确认数，成功不自动打开', async () => {
      const methods: string[] = [];
      let posts = 0;
      let reconciles = 0;
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
        assert.equal(requestUrl(input).pathname, '/api/v2/plugins/mirroring/recovery');
        methods.push(init?.method ?? '');
        if (init?.method === 'POST') ++posts;
        return success(view(init?.method === 'POST' ? {
          cleanup_failed: posts === 1, last_report: report(posts === 1 ? 'blocked' : 'recovered'),
        } : {}));
      } });
      function Harness() {
        const recovery = usePluginRecovery({ client, active: true,
          target: { key: 'device-a:g1', deviceId: 'device-a' }, failures: [], blocked: false,
          onRecovered: async () => { ++reconciles; } });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => { root.render(createElement(Harness)); });
      assert.equal(button('核对并恢复').disabled, false);
      await click('核对并恢复');
      assert.match(target.textContent ?? '', /仍有资源未确认/);
      assert.match(target.textContent ?? '', /覆盖整个插件.*已检查 4 项.*未确认 2 项/);
      assert.ok(target.querySelector('ul[aria-label="资源核对明细"]'));
      assert.equal(reconciles, 0);
      assert.equal(posts, 1);
      await click('核对并恢复');
      assert.match(target.textContent ?? '', /资源核对已通过/);
      assert.match(target.textContent ?? '', /请点击“开始投屏”/);
      assert.equal(reconciles, 1);
      assert.deepEqual(methods, ['GET', 'GET', 'POST', 'GET', 'POST']);
      await reset();
    });

    await t.test('busy、活动会话、不支持和 404 都有可读状态，保留日志到现有反馈复制', async () => {
      const error = new ApiError('http', 'not_found', '旧宿主原始错误', 404, 'old-host-log');
      let calls = 0;
      const render = async (snapshot: PluginRecoverySnapshot, activeSession = false) => {
        await act(async () => { root.render(createElement(MessageProvider, {
          controller: messages,
          children: createElement(RecoveryPanel, { state: snapshot, activeSession,
            recover: async () => { ++calls; }, refresh: noAction, cancel() {} }),
        })); });
      };
      await render(state({ result: { data: view({ recovering: true }), logId: 'busy-log' } }));
      assert.match(target.textContent ?? '', /正在核对投屏资源/);
      assert.equal(button('核对并恢复').disabled, true);
      assert.equal(button('读取状态').disabled, false);
      await render(state({ result: { data: view(), logId: 'read-log' } }), true);
      assert.equal(button('核对并恢复').disabled, true);
      assert.match(target.textContent ?? '', /先释放当前投屏会话/);
      await render(state({ result: { data: view({ supported: false }), logId: 'unsupported-log' } }));
      assert.equal(button('核对并恢复').disabled, true);
      assert.match(target.textContent ?? '', /请升级投屏插件/);
      await render(state({ unavailable: true, error }));
      assert.match(target.textContent ?? '', /404.*请升级宿主/);
      assert.match(target.textContent ?? '', /old-host-log/);
      assert.equal(messages.snapshot().some((message) => message.logId === 'old-host-log'), true);
      await settled(() => document.querySelector('button[aria-label="复制消息日志 ID"]') !== null, '未接入现有日志复制入口');
      const copy = document.querySelector('button[aria-label="复制消息日志 ID"]');
      assert.ok(copy instanceof windowRef.HTMLButtonElement);
      const copied: string[] = [];
      Object.defineProperty(windowRef.navigator, 'clipboard', { configurable: true,
        value: { writeText: async (value: string) => { copied.push(value); } } });
      await act(async () => { copy.click(); });
      assert.deepEqual(copied, ['old-host-log']);
      await click('核对并恢复');
      assert.equal(calls, 0);
      await reset();
    });

    await t.test('失败晚于在途查询时最多补读一次，ownership 阻塞触发读取而不提交恢复', async () => {
      const delayed = deferred<Response>();
      let reads = 0;
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (_, init) => {
        assert.equal(init?.method, 'GET');
        if (++reads === 1) return delayed.promise;
        return success(view({ last_report: report('blocked') }));
      } });
      function Harness({ failure: currentFailure, blocked }: { failure: unknown; blocked: boolean }) {
        const recovery = usePluginRecovery({ client, active: true,
          target: { key: 'device-a:g1', deviceId: 'device-a' }, failures: [currentFailure], blocked, onRecovered: noAction });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => { root.render(createElement(Harness, { failure: null, blocked: false })); });
      const original = new ApiError('http', 'conflict', '原投屏失败', 409, 'original-open-log');
      await act(async () => { root.render(createElement(Harness, { failure: original, blocked: false })); });
      assert.equal(reads, 1);
      await act(async () => { delayed.resolve(success(view({ cleanup_failed: false }))); });
      await settled(() => reads === 2 && (target.textContent ?? '').includes('仍有资源未确认'), '失败后未补读恢复状态');
      await act(async () => { root.render(createElement(Harness, { failure: original, blocked: true })); });
      assert.equal(reads, 3);
      await act(async () => { root.render(createElement(Harness, { failure: original, blocked: true })); });
      assert.equal(reads, 3);
      assert.equal(original.logId, 'original-open-log');
      await reset();
    });

    await t.test('已受理的自动恢复会只读跟踪到终态，不要求用户手动刷新', async () => {
      let reads = 0;
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (_, init) => {
        assert.equal(init?.method, 'GET');
        ++reads;
        return success(reads === 1 ? view({ recovering: true })
          : view({ recovering: false, cleanup_failed: false, last_report: report() }));
      } });
      function Harness() {
        const recovery = usePluginRecovery({ client, active: true,
          target: { key: 'plugin:mirroring' }, failures: [], blocked: false, onRecovered: noAction });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => { root.render(createElement(Harness)); });
      assert.match(target.textContent ?? '', /正在核对投屏资源/);
      await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 650)); });
      await settled(() => (target.textContent ?? '').includes('资源核对已通过'), '自动核对终态没有更新到页面');
      assert.equal(reads, 2);
      await reset();
    });

    await t.test('取消和切设备撤销旧请求，迟到恢复不影响新设备或触发开启', async () => {
      const delayed = deferred<Response>();
      let posts = 0;
      let reads = 0;
      let reconciles = 0;
      const inputs: unknown[] = [];
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (_, init) => {
        if (init?.method === 'POST') { ++posts; inputs.push(JSON.parse(String(init.body))); return delayed.promise; }
        ++reads;
        return success(view());
      } });
      function Harness({ selected }: { selected: RecoveryTarget }) {
        const recovery = usePluginRecovery({ client, active: true, target: selected, failures: [], blocked: false,
          onRecovered: async () => { ++reconciles; } });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => { root.render(createElement(Harness, { selected: { key: 'a:g1', deviceId: 'device-a' } })); });
      await click('核对并恢复');
      assert.match(target.textContent ?? '', /正在核对投屏资源/);
      assert.equal(button('核对并恢复').disabled, true);
      assert.ok(button('取消等待'));
      await act(async () => { root.render(createElement(Harness, { selected: { key: 'b:g1', deviceId: 'device-b' } })); });
      await act(async () => { delayed.resolve(success(view({ cleanup_failed: false, last_report: report() }))); });
      assert.match(target.textContent ?? '', /核对目标：device-b/);
      assert.doesNotMatch(target.textContent ?? '', /资源核对已通过/);
      assert.equal(posts, 1);
      assert.equal(reads, 3);
      assert.equal(reconciles, 0);
      assert.deepEqual(inputs, [{ generation: 'g1', input: { device_id: 'device-a' } }]);
      await reset();
    });

    await t.test('点击取消等待后只回读一次，busy 状态可见且没有自动再次恢复', async () => {
      const delayed = deferred<Response>();
      let reads = 0;
      let posts = 0;
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (_, init) => {
        if (init?.method === 'POST') { ++posts; return delayed.promise; }
        ++reads;
        return success(view({ recovering: reads >= 3 }));
      } });
      function Harness() {
        const recovery = usePluginRecovery({ client, active: true,
          target: { key: 'a:g1', deviceId: 'device-a' }, failures: [], blocked: false, onRecovered: noAction });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => { root.render(createElement(Harness)); });
      await click('核对并恢复');
      await click('取消等待');
      await settled(() => reads === 3 && (target.textContent ?? '').includes('服务器可能仍在处理'), '取消后缺少真实状态回读');
      assert.match(target.textContent ?? '', /服务器正在核对，请稍后读取状态/);
      assert.equal(button('核对并恢复').disabled, true);
      assert.equal(posts, 1);
      assert.equal(target.querySelector('button')?.textContent, '核对并恢复');
      await act(async () => { delayed.resolve(success(view({ cleanup_failed: false, last_report: report() }))); });
      assert.doesNotMatch(target.textContent ?? '', /资源核对已通过/);
      assert.equal(reads, 3);
      await reset();
    });

    await t.test('无设备核对全部资源取消后也只 GET 复查一次，不重发空输入 POST', async () => {
      const delayed = deferred<Response>();
      const posted: unknown[] = [];
      let reads = 0;
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (_, init) => {
        if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return delayed.promise; }
        ++reads;
        return success(view({ recovering: reads >= 3 }));
      } });
      function Harness() {
        const recovery = usePluginRecovery({ client, active: true, target: { key: 'plugin:mirroring' },
          failures: [], blocked: false, onRecovered: noAction });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => { root.render(createElement(Harness)); });
      assert.equal(button('核对全部投屏资源').disabled, false);
      await click('核对全部投屏资源');
      await click('取消等待');
      await settled(() => reads === 3 && (target.textContent ?? '').includes('服务器可能仍在处理'), '全插件核对取消后未回读');
      assert.deepEqual(posted, [{ generation: 'g1', input: {} }]);
      assert.match(target.textContent ?? '', /核对目标：全部投屏资源（全插件）/);
      assert.equal(button('读取状态').disabled, false);
      await act(async () => { delayed.resolve(success(view({ cleanup_failed: false, last_report: report() }))); });
      assert.equal(reads, 3);
      assert.equal(posted.length, 1);
      assert.doesNotMatch(target.textContent ?? '', /资源核对已通过/);
      await reset();
    });

    await t.test('重启后未选设备、无操作目录仍可读取和核对全部资源，切应用栏入口常驻', async () => {
      const paths: string[] = [];
      const posts: unknown[] = [];
      let latest = view();
      const services = createProductServices({ baseUrl: 'http://localhost', panelTarget: () => target,
        transport: async (input, init) => {
          const path = requestUrl(input).pathname;
          paths.push(path);
          if (path.endsWith('/session-definitions')) return success({ revision: 1, sessions: [] });
          if (path.endsWith('/recovery')) {
            if (init?.method === 'POST') {
              posts.push(JSON.parse(String(init.body)));
              latest = view({ cleanup_failed: false, last_report: report() });
            }
            return success(latest);
          }
          if (path.endsWith('/operations')) return success([]);
          throw new Error('不应请求设备或其他服务');
        } });
      const { DeviceScreen } = await import('../src/pages/devices/screen/index.tsx');
      try {
        await services.runtime.operations.refresh(signal());
        await act(async () => { root.render(createElement(DeviceScreen, { services, active: true })); });
        assert.ok(target.querySelector('section[aria-label="投屏恢复"]'));
        assert.match(target.textContent ?? '', /核对目标：全部投屏资源（全插件）/);
        assert.equal(button('核对全部投屏资源').disabled, false);
        assert.equal(button('读取状态').disabled, false);
        await click('核对全部投屏资源');
        assert.match(target.textContent ?? '', /资源核对已通过/);
        assert.deepEqual(posts, [{ generation: 'g1', input: {} }]);
        await act(async () => { root.render(createElement(DeviceScreen, { services, active: true, pane: 'apps' })); });
        assert.ok(target.querySelector('section[aria-label="投屏恢复"]'));
        assert.equal(button('核对全部投屏资源').disabled, false);
        assert.equal(paths.some((path) => path.includes('/device-actions') || path.endsWith('/jobs')), false);
        assert.equal(paths.some((path) => path.includes('/device-providers') || path.endsWith('/devices')), false);
      } finally {
        await reset();
        await services.dispose();
      }
    });

    await t.test('实际投屏页选中设备后无操作目录也能核对，恢复后不提交投屏或设备动作', async () => {
      const requests: { path: string; method: string; body: unknown }[] = [];
      const observed = directory('android-device', 'g1', ['device-a']);
      const services = createProductServices({ baseUrl: 'http://localhost', panelTarget: () => target,
        transport: async (input, init) => {
          const path = requestUrl(input).pathname;
          requests.push({ path, method: init?.method ?? '', body: init?.body ? JSON.parse(String(init.body)) : null });
          if (path.endsWith('/session-definitions')) return success({ revision: 1, sessions: [] });
          if (path.endsWith('/device-providers')) return success([observed.provider]);
          if (path.endsWith('/devices')) return success([observed]);
          if (path.endsWith('/operations')) return success([]);
          if (path.endsWith('/recovery')) return success(view(init?.method === 'POST'
            ? { cleanup_failed: false, last_report: report() } : {}));
          throw new Error('不能提交其他投屏或设备动作');
        } });
      const { DeviceScreen } = await import('../src/pages/devices/screen/index.tsx');
      try {
        await services.runtime.operations.refresh(signal());
        await services.runtime.devices.refreshDirectories(signal());
        services.runtime.devices.select({ providerId: 'android-device', generation: 'g1', localId: 'device-a' });
        await act(async () => { root.render(createElement(DeviceScreen, { services, active: true })); });
        assert.equal(button('开始投屏').disabled, true);
        assert.equal(button('核对并恢复').disabled, false);
        await click('核对并恢复');
        assert.match(target.textContent ?? '', /资源核对已通过/);
        assert.match(target.textContent ?? '', /未确认 0 项/);
        assert.deepEqual(requests.filter((request) => request.method === 'POST'), [{
          path: '/api/v2/plugins/mirroring/recovery', method: 'POST',
          body: { generation: 'g1', input: { device_id: 'device-a' } },
        }]);
      } finally {
        await reset();
        await services.dispose();
      }
    });

    await t.test('分享页从链接设备核对，手动恢复不会自动重放首次被 busy 拒绝的 open', async () => {
      windowRef.location.hash = '#devices?share_device=shared-device&share_control=0';
      const posts: unknown[] = [];
      let busy = true;
      let latest = view();
      const services = createProductServices({ baseUrl: 'http://localhost', panelTarget: () => target,
        transport: async (input, init) => {
          const path = requestUrl(input).pathname;
          if (path.endsWith('/session-definitions')) return success({ revision: 1, sessions: [] });
          if (path.endsWith('/recovery')) {
            if (init?.method === 'POST') {
              posts.push(JSON.parse(String(init.body)));
              latest = view({ cleanup_failed: false, last_report: report() });
              return success(latest);
            }
            return success({ ...latest, recovering: busy });
          }
          throw new Error('不得自动重放分享投屏或设备动作');
        } });
      const { DeviceScreen } = await import('../src/pages/devices/screen/index.tsx');
      try {
        await act(async () => { root.render(createElement(DeviceScreen, { services, active: true })); });
        await settled(() => (target.textContent ?? '').includes('正在核对投屏资源'), '分享设备未消费恢复状态');
        assert.match(target.textContent ?? '', /核对目标：shared-device/);
        assert.equal(button('核对并恢复').disabled, true);
        busy = false;
        await click('读取状态');
        await click('核对并恢复');
        assert.deepEqual(posts, [{ generation: 'g1', input: { device_id: 'shared-device' } }]);
        assert.match(target.textContent ?? '', /资源核对已通过/);
        assert.equal(services.webRtcMirroring.snapshot().session, null);
      } finally {
        await reset();
        await services.dispose();
        windowRef.location.hash = '';
      }
    });
  } finally {
    await act(async () => { root.unmount(); });
    messages.dispose();
    windowRef.close();
    loader.deregister();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
