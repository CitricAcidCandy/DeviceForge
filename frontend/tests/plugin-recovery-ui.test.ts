import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { PluginRecoveryView, SessionInfo } from '../src/services/api/index.ts';
import type {
  PluginRecoverySnapshot,
  RecoveryTarget,
} from '../src/features/plugin-recovery/index.ts';
import { createProductServices } from '../src/app/product/services.ts';
import { createMessageController } from '../src/components/Message/controller.ts';
import { directory } from './device-fixtures.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const report = (
  status: 'recovered' | 'blocked' | 'busy' = 'recovered',
): NonNullable<PluginRecoveryView['last_report']> => ({
  status,
  coverage: 'plugin',
  inspected: 4,
  remaining: status === 'recovered' ? 0 : 2,
  message: status === 'recovered' ? '全部资源已确认' : '有资源仍未确认',
  checks: [
    {
      resource: 'control',
      status: status === 'recovered' ? 'confirmed' : status,
      message: '控制通道核对结果',
    },
  ],
});
const view = (patch: Partial<PluginRecoveryView> = {}): PluginRecoveryView => ({
  id: 'mirroring',
  generation: 'g1',
  supported: true,
  cleanup_failed: true,
  recovering: false,
  last_report: null,
  ...patch,
});
const state = (patch: Partial<PluginRecoverySnapshot> = {}): PluginRecoverySnapshot => ({
  target: { key: 'device-a:g1', deviceId: 'device-a' },
  phase: 'idle',
  result: null,
  error: null,
  unavailable: false,
  cancelled: false,
  reportTarget: null,
  ...patch,
});

function androidDirectory() {
  const observed = directory('android-device', 'g1', ['device-a']);
  return { ...observed, provider: { ...observed.provider, definition: {
    ...observed.provider.definition,
    capabilities: observed.provider.definition.capabilities.map((capability) => ({
      ...capability, operation: `plugin.android-device.${capability.id}`,
    })),
  } } };
}

async function settled(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 30 && !condition(); ++attempt)
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  assert.ok(condition(), message);
}

test('恢复面板与投屏页的真实 React 行为（无服务监听、无真实设备请求）', async (t) => {
  // 只在本进程编译 TSX；不启动 Vite、浏览器或后台服务器。
  const loader = registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && url.endsWith('.tsx'))
        return {
          shortCircuit: true,
          format: 'module',
          source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
            fileName: url,
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
              jsx: ts.JsxEmit.ReactJSX,
            },
          }).outputText,
        };
      if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
      return nextLoad(url, context);
    },
  });
  const browser = new JSDOM(
    '<!doctype html><html><body><main id="recovery-test"></main></body></html>',
    {
      url: 'http://localhost:5173/',
      pretendToBeVisual: true,
    },
  );
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef,
    document: windowRef.document,
    navigator: windowRef.navigator,
    Element: windowRef.Element,
    HTMLElement: windowRef.HTMLElement,
    Node: windowRef.Node,
    DocumentFragment: windowRef.DocumentFragment,
    MutationObserver: windowRef.MutationObserver,
    HTMLInputElement: windowRef.HTMLInputElement,
    HTMLFormElement: windowRef.HTMLFormElement,
    HTMLSelectElement: windowRef.HTMLSelectElement,
    HTMLTextAreaElement: windowRef.HTMLTextAreaElement,
    HTMLButtonElement: windowRef.HTMLButtonElement,
    HTMLVideoElement: windowRef.HTMLVideoElement,
    HTMLCanvasElement: windowRef.HTMLCanvasElement,
    Event: windowRef.Event,
    CustomEvent: windowRef.CustomEvent,
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
  const target = windowRef.document.getElementById('recovery-test');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const { RecoveryPanel, usePluginRecovery } = await import(
    '../src/pages/devices/screen/RecoveryPanel/index.tsx'
  );
  const { MessageProvider } = await import('../src/components/Message/index.tsx');
  const messages = createMessageController();
  const button = (label: string, within: ParentNode = target) => {
    const found = Array.from(within.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === label,
    );
    assert.ok(found, `缺少按钮：${label}`);
    return found;
  };
  const click = async (label: string) => {
    await act(async () => {
      button(label).click();
    });
  };
  const showDetails = async () => {
    const toggle = target.querySelector<HTMLButtonElement>(
      'section[aria-label="投屏恢复"] button[aria-expanded]',
    );
    assert.ok(toggle, '缺少诊断详情入口');
    if (toggle.getAttribute('aria-expanded') === 'false')
      await act(async () => {
        toggle.click();
      });
  };
  const reset = async () => {
    await act(async () => {
      root.render(null);
      messages.clear();
    });
  };
  const noAction = async () => undefined;
  try {
    await t.test('异常只展示紧凑恢复入口，技术明细按需展开，正常状态降为连接排查', async () => {
      const snapshot = state({
        result: { data: view({ last_report: report('blocked') }), logId: 'blocked-log' },
      });
      await act(async () => {
        root.render(
          createElement(RecoveryPanel, {
            state: snapshot,
            activeSession: false,
            recover: noAction,
            refresh: noAction,
            cancel() {},
          }),
        );
      });
      assert.match(target.textContent ?? '', /投屏连接待恢复/);
      assert.equal(button('核对并恢复').disabled, false);
      assert.equal(button('查看详情').getAttribute('aria-expanded'), 'false');
      assert.equal(target.querySelector('ul[aria-label="资源核对明细"]'), null);
      assert.doesNotMatch(
        target.textContent ?? '',
        /核对目标|控制通道核对结果|读取状态|覆盖整个插件/,
      );
      await click('查看详情');
      assert.equal(button('收起详情').getAttribute('aria-expanded'), 'true');
      assert.ok(target.querySelector('ul[aria-label="资源核对明细"]'));
      assert.match(target.textContent ?? '', /核对目标：device-a/);
      await click('收起详情');
      assert.equal(target.querySelector('ul[aria-label="资源核对明细"]'), null);
      await showDetails();
      await act(async () => {
        root.render(
          createElement(RecoveryPanel, {
            state: { ...snapshot, target: { key: 'device-b:g1', deviceId: 'device-b' } },
            activeSession: false,
            recover: noAction,
            refresh: noAction,
            cancel() {},
          }),
        );
      });
      assert.equal(button('查看详情').getAttribute('aria-expanded'), 'false');
      assert.equal(target.querySelector('ul[aria-label="资源核对明细"]'), null);
      await act(async () => {
        root.render(
          createElement(RecoveryPanel, {
            activeSession: false,
            state: state({
              result: { data: view({ cleanup_failed: false }), logId: 'healthy-log' },
            }),
            recover: noAction,
            refresh: noAction,
            cancel() {},
          }),
        );
      });
      assert.equal(target.textContent?.trim(), '连接排查');
      await click('连接排查');
      assert.equal(button('核对并恢复').disabled, false);
      assert.ok(button('读取状态'));
      await reset();
    });

    await t.test('手动核对可独立使用，显示全插件检查与未确认数，成功不自动打开', async () => {
      const methods: string[] = [];
      let posts = 0;
      let reconciles = 0;
      const client = createApiClient({
        baseUrl: 'http://localhost',
        transport: async (input, init) => {
          assert.equal(requestUrl(input).pathname, '/api/v2/plugins/mirroring/recovery');
          methods.push(init?.method ?? '');
          if (init?.method === 'POST') ++posts;
          return success(
            view(
              init?.method === 'POST'
                ? {
                    cleanup_failed: posts === 1,
                    last_report: report(posts === 1 ? 'blocked' : 'recovered'),
                  }
                : {},
            ),
          );
        },
      });
      function Harness() {
        const recovery = usePluginRecovery({
          client,
          active: true,
          target: { key: 'device-a:g1', deviceId: 'device-a' },
          failures: [],
          blocked: false,
          onRecovered: async () => {
            ++reconciles;
          },
        });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => {
        root.render(createElement(Harness));
      });
      await showDetails();
      assert.equal(button('核对并恢复').disabled, false);
      await click('核对并恢复');
      assert.match(target.textContent ?? '', /投屏连接待恢复/);
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
        await act(async () => {
          root.render(
            createElement(MessageProvider, {
              controller: messages,
              children: createElement(RecoveryPanel, {
                state: snapshot,
                activeSession,
                recover: async () => {
                  ++calls;
                },
                refresh: noAction,
                cancel() {},
              }),
            }),
          );
        });
        await showDetails();
      };
      await render(state({ result: { data: view({ recovering: true }), logId: 'busy-log' } }));
      assert.match(target.textContent ?? '', /正在核对投屏资源/);
      assert.equal(button('核对并恢复').disabled, true);
      assert.equal(button('读取状态').disabled, false);
      await render(state({ result: { data: view(), logId: 'read-log' } }), true);
      assert.equal(button('核对并恢复').disabled, true);
      assert.match(target.textContent ?? '', /先释放当前投屏会话/);
      await render(
        state({ result: { data: view({ supported: false }), logId: 'unsupported-log' } }),
      );
      assert.equal(button('核对并恢复').disabled, true);
      assert.match(target.textContent ?? '', /请升级投屏插件/);
      await render(state({ unavailable: true, error }));
      assert.match(target.textContent ?? '', /404.*请升级宿主/);
      assert.match(target.textContent ?? '', /old-host-log/);
      assert.equal(
        messages.snapshot().some((message) => message.logId === 'old-host-log'),
        true,
      );
      await settled(
        () => document.querySelector('button[aria-label="复制消息日志 ID"]') !== null,
        '未接入现有日志复制入口',
      );
      const copy = document.querySelector('button[aria-label="复制消息日志 ID"]');
      assert.ok(copy instanceof windowRef.HTMLButtonElement);
      const copied: string[] = [];
      Object.defineProperty(windowRef.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            copied.push(value);
          },
        },
      });
      await act(async () => {
        copy.click();
      });
      assert.deepEqual(copied, ['old-host-log']);
      await click('核对并恢复');
      assert.equal(calls, 0);
      await reset();
    });

    await t.test('失败晚于在途查询时最多补读一次，ownership 阻塞触发读取而不提交恢复', async () => {
      const delayed = deferred<Response>();
      let reads = 0;
      const client = createApiClient({
        baseUrl: 'http://localhost',
        transport: async (_, init) => {
          assert.equal(init?.method, 'GET');
          if (++reads === 1) return delayed.promise;
          return success(view({ last_report: report('blocked') }));
        },
      });
      function Harness({
        failure: currentFailure,
        blocked,
      }: {
        failure: unknown;
        blocked: boolean;
      }) {
        const recovery = usePluginRecovery({
          client,
          active: true,
          target: { key: 'device-a:g1', deviceId: 'device-a' },
          failures: [currentFailure],
          blocked,
          onRecovered: noAction,
        });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => {
        root.render(createElement(Harness, { failure: null, blocked: false }));
      });
      await showDetails();
      const original = new ApiError('http', 'conflict', '原投屏失败', 409, 'original-open-log');
      await act(async () => {
        root.render(createElement(Harness, { failure: original, blocked: false }));
      });
      assert.equal(reads, 1);
      await act(async () => {
        delayed.resolve(success(view({ cleanup_failed: false })));
      });
      await settled(
        () => reads === 2 && (target.textContent ?? '').includes('投屏连接待恢复'),
        '失败后未补读恢复状态',
      );
      await act(async () => {
        root.render(createElement(Harness, { failure: original, blocked: true }));
      });
      assert.equal(reads, 3);
      await act(async () => {
        root.render(createElement(Harness, { failure: original, blocked: true }));
      });
      assert.equal(reads, 3);
      assert.equal(original.logId, 'original-open-log');
      await reset();
    });

    await t.test('已受理的自动恢复会只读跟踪到终态，不要求用户手动刷新', async () => {
      let reads = 0;
      const client = createApiClient({
        baseUrl: 'http://localhost',
        transport: async (_, init) => {
          assert.equal(init?.method, 'GET');
          ++reads;
          return success(
            reads === 1
              ? view({ recovering: true })
              : view({ recovering: false, cleanup_failed: false, last_report: report() }),
          );
        },
      });
      function Harness() {
        const recovery = usePluginRecovery({
          client,
          active: true,
          target: { key: 'plugin:mirroring' },
          failures: [],
          blocked: false,
          onRecovered: noAction,
        });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => {
        root.render(createElement(Harness));
      });
      await showDetails();
      assert.match(target.textContent ?? '', /正在核对投屏资源/);
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 650));
      });
      await settled(
        () => (target.textContent ?? '').includes('资源核对已通过'),
        '自动核对终态没有更新到页面',
      );
      assert.equal(reads, 2);
      await reset();
    });

    await t.test('取消和切设备撤销旧请求，迟到恢复不影响新设备或触发开启', async () => {
      const delayed = deferred<Response>();
      let posts = 0;
      let reads = 0;
      let reconciles = 0;
      const inputs: unknown[] = [];
      const client = createApiClient({
        baseUrl: 'http://localhost',
        transport: async (_, init) => {
          if (init?.method === 'POST') {
            ++posts;
            inputs.push(JSON.parse(String(init.body)));
            return delayed.promise;
          }
          ++reads;
          return success(view());
        },
      });
      function Harness({ selected }: { selected: RecoveryTarget }) {
        const recovery = usePluginRecovery({
          client,
          active: true,
          target: selected,
          failures: [],
          blocked: false,
          onRecovered: async () => {
            ++reconciles;
          },
        });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => {
        root.render(createElement(Harness, { selected: { key: 'a:g1', deviceId: 'device-a' } }));
      });
      await showDetails();
      await click('核对并恢复');
      assert.match(target.textContent ?? '', /正在核对投屏资源/);
      assert.equal(button('核对并恢复').disabled, true);
      assert.ok(button('取消等待'));
      await act(async () => {
        root.render(createElement(Harness, { selected: { key: 'b:g1', deviceId: 'device-b' } }));
      });
      await act(async () => {
        delayed.resolve(success(view({ cleanup_failed: false, last_report: report() })));
      });
      await showDetails();
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
      const client = createApiClient({
        baseUrl: 'http://localhost',
        transport: async (_, init) => {
          if (init?.method === 'POST') {
            ++posts;
            return delayed.promise;
          }
          ++reads;
          return success(view({ recovering: reads >= 3 }));
        },
      });
      function Harness() {
        const recovery = usePluginRecovery({
          client,
          active: true,
          target: { key: 'a:g1', deviceId: 'device-a' },
          failures: [],
          blocked: false,
          onRecovered: noAction,
        });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => {
        root.render(createElement(Harness));
      });
      await showDetails();
      await click('核对并恢复');
      await click('取消等待');
      await settled(
        () => reads === 3 && (target.textContent ?? '').includes('服务器可能仍在处理'),
        '取消后缺少真实状态回读',
      );
      assert.match(target.textContent ?? '', /服务器正在核对，请稍后读取状态/);
      assert.equal(button('核对并恢复').disabled, true);
      assert.equal(posts, 1);
      assert.equal(target.querySelector('button')?.textContent, '核对并恢复');
      await act(async () => {
        delayed.resolve(success(view({ cleanup_failed: false, last_report: report() })));
      });
      assert.doesNotMatch(target.textContent ?? '', /资源核对已通过/);
      assert.equal(reads, 3);
      await reset();
    });

    await t.test('无设备核对全部资源取消后也只 GET 复查一次，不重发空输入 POST', async () => {
      const delayed = deferred<Response>();
      const posted: unknown[] = [];
      let reads = 0;
      const client = createApiClient({
        baseUrl: 'http://localhost',
        transport: async (_, init) => {
          if (init?.method === 'POST') {
            posted.push(JSON.parse(String(init.body)));
            return delayed.promise;
          }
          ++reads;
          return success(view({ recovering: reads >= 3 }));
        },
      });
      function Harness() {
        const recovery = usePluginRecovery({
          client,
          active: true,
          target: { key: 'plugin:mirroring' },
          failures: [],
          blocked: false,
          onRecovered: noAction,
        });
        return createElement(RecoveryPanel, { activeSession: false, ...recovery });
      }
      await act(async () => {
        root.render(createElement(Harness));
      });
      await showDetails();
      assert.equal(button('核对全部投屏资源').disabled, false);
      await click('核对全部投屏资源');
      await click('取消等待');
      await settled(
        () => reads === 3 && (target.textContent ?? '').includes('服务器可能仍在处理'),
        '全插件核对取消后未回读',
      );
      assert.deepEqual(posted, [{ generation: 'g1', input: {} }]);
      assert.match(target.textContent ?? '', /核对目标：全部投屏资源（全插件）/);
      assert.equal(button('读取状态').disabled, false);
      await act(async () => {
        delayed.resolve(success(view({ cleanup_failed: false, last_report: report() })));
      });
      assert.equal(reads, 3);
      assert.equal(posted.length, 1);
      assert.doesNotMatch(target.textContent ?? '', /资源核对已通过/);
      await reset();
    });

    await t.test('重启后未选设备、无操作目录仍可读取和核对全部资源，切应用栏入口常驻', async () => {
      const paths: string[] = [];
      const posts: unknown[] = [];
      let latest = view();
      const services = createProductServices({
        baseUrl: 'http://localhost',
        panelTarget: () => target,
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
        },
      });
      const { DeviceScreen } = await import('../src/pages/devices/screen/index.tsx');
      try {
        await services.runtime.operations.refresh(signal());
        await act(async () => {
          root.render(createElement(DeviceScreen, { services, active: true }));
        });
        await showDetails();
        assert.ok(target.querySelector('section[aria-label="投屏恢复"]'));
        assert.match(target.textContent ?? '', /核对目标：全部投屏资源（全插件）/);
        assert.equal(button('核对全部投屏资源').disabled, false);
        assert.equal(button('读取状态').disabled, false);
        await click('核对全部投屏资源');
        assert.match(target.textContent ?? '', /资源核对已通过/);
        assert.deepEqual(posts, [{ generation: 'g1', input: {} }]);
        await act(async () => {
          root.render(createElement(DeviceScreen, { services, active: true, pane: 'apps' }));
        });
        assert.ok(target.querySelector('section[aria-label="投屏恢复"]'));
        assert.equal(button('核对全部投屏资源').disabled, false);
        assert.equal(
          paths.some((path) => path.includes('/device-actions') || path.endsWith('/jobs')),
          false,
        );
        assert.equal(
          paths.some((path) => path.includes('/device-providers') || path.endsWith('/devices')),
          false,
        );
      } finally {
        await reset();
        await services.dispose();
      }
    });

    await t.test('实际投屏页缺少直播会话能力仍禁用开始按钮，但无操作目录也能核对', async () => {
      const requests: { path: string; method: string; body: unknown }[] = [];
      const observed = androidDirectory();
      const services = createProductServices({
        baseUrl: 'http://localhost',
        panelTarget: () => target,
        transport: async (input, init) => {
          const path = requestUrl(input).pathname;
          requests.push({
            path,
            method: init?.method ?? '',
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          if (path.endsWith('/session-definitions')) return success({ revision: 1, sessions: [] });
          if (path.endsWith('/device-providers')) return success([observed.provider]);
          if (path.endsWith('/devices')) return success([observed]);
          if (path.endsWith('/operations')) return success([]);
          if (path.endsWith('/recovery'))
            return success(
              view(init?.method === 'POST' ? { cleanup_failed: false, last_report: report() } : {}),
            );
          throw new Error('不能提交其他投屏或设备动作');
        },
      });
      const { DeviceScreen } = await import('../src/pages/devices/screen/index.tsx');
      try {
        await services.runtime.operations.refresh(signal());
        await services.runtime.devices.refreshDirectories(signal());
        services.runtime.devices.select({
          providerId: 'android-device',
          generation: 'g1',
          localId: 'device-a',
        });
        await act(async () => {
          root.render(createElement(DeviceScreen, { services, active: true }));
        });
        await showDetails();
        assert.equal(services.runtime.devices.snapshot().selected?.state, 'online');
        assert.deepEqual(services.runtime.mirroringStreaming.snapshot().definitions?.sessions, []);
        assert.equal(button('开始投屏').disabled, true, '缺少直播会话能力，不能因恢复门禁移除而开放');
        assert.equal(button('核对并恢复').disabled, false);
        await click('核对并恢复');
        assert.match(target.textContent ?? '', /资源核对已通过/);
        assert.match(target.textContent ?? '', /未确认 0 项/);
        assert.deepEqual(
          requests.filter((request) => request.method === 'POST'),
          [
            {
              path: '/api/v2/plugins/mirroring/recovery',
              method: 'POST',
              body: { generation: 'g1', input: { device_id: 'device-a' } },
            },
          ],
        );
      } finally {
        await reset();
        await services.dispose();
      }
    });

    for (const manual of [false, true]) {
      await t.test(`实际投屏页${manual ? '手动恢复 POST 在途' : '后台 recovering=true'}时开始按钮可用且实际提交 open`, async () => {
        const requests: { path: string; method: string; body: unknown }[] = [];
        const delayed = deferred<Response>();
        const output = deferred<Response>();
        const observed = androidDirectory();
        const identity: SessionInfo = {
          id: '12345678-1234-1234-1234-123456789abc', operation: 'plugin.mirroring.open',
          plugin_id: 'mirroring', generation: 'g1', created_at: 1, status: 'opening', output_sequence: 0,
        };
        const services = createProductServices({
          baseUrl: 'http://localhost',
          panelTarget: () => target,
          transport: async (input, init) => {
            const path = requestUrl(input).pathname;
            const method = init?.method ?? '';
            requests.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
            if (path.endsWith('/session-definitions')) return success({ revision: 1, sessions: [{
              id: identity.operation, title: '直播投屏', input_schema: { type: 'object' },
              execution: { api_version: 1, source: 'declared', total_timeout_ms: 3600000 },
            }] });
            if (path.endsWith('/device-providers')) return success([observed.provider]);
            if (path.endsWith('/devices')) return success([observed]);
            if (path.endsWith('/operations')) return success([]);
            if (path.endsWith('/recovery')) {
              if (method === 'POST') return delayed.promise;
              return success(view({ recovering: !manual }), 'background-recovery-log');
            }
            if (path === '/api/v2/sessions' && method === 'POST') return success(identity, 'actual-open-log', 202);
            if (path.endsWith('/output')) return output.promise;
            if (path.endsWith('/release')) return success({ ...identity, status: 'stopping' }, 'release-log', 202);
            throw new Error('不能发送其他设备或会话动作');
          },
        });
        // 只替换 JSDOM 不具备的媒体展示端，能力发现、恢复模型与 open 均走真实工厂和 HTTP 客户端。
        services.mediaDisplay.prepare = noAction;
        services.mediaDisplay.bind = () => undefined;
        const { DeviceScreen } = await import('../src/pages/devices/screen/index.tsx');
        try {
          await services.runtime.operations.refresh(signal());
          await services.runtime.devices.refreshDirectories(signal());
          services.runtime.devices.select({ providerId: 'android-device', generation: 'g1', localId: 'device-a' });
          await act(async () => {
            root.render(createElement(DeviceScreen, { services, active: true }));
          });
          await settled(() => services.runtime.mirroringStreaming.snapshot().definitions !== null, '未读取直播会话能力');
          await showDetails();
          if (manual) {
            await click('核对并恢复');
            await settled(() => requests.some((request) => request.path.endsWith('/recovery') && request.method === 'POST'),
              '手动恢复未进入 POST 等待');
            assert.equal(button('取消等待').disabled, false);
          } else {
            await settled(() => (target.textContent ?? '').includes('正在核对投屏资源'), '未消费后台 recovering 状态');
            assert.equal(button('核对并恢复').disabled, true, '同类手动恢复仍去重，但不能禁用开始投屏');
          }
          assert.equal(button('开始投屏').disabled, false, '恢复状态不能充当新会话的前台锁');
          await click('开始投屏');
          await settled(() => services.runtime.mirroringStreaming.snapshot().session?.id === identity.id,
            '点击开始后未实际接受新投屏会话');
          const opens = requests.filter((request) => request.path === '/api/v2/sessions' && request.method === 'POST');
          assert.equal(opens.length, 1);
          assert.equal(services.runtime.mirroringStreaming.snapshot().logs.open, 'actual-open-log');
          const openingBody = opens[0]?.body;
          assert.ok(openingBody !== null && typeof openingBody === 'object' && 'operation' in openingBody && 'input' in openingBody);
          assert.equal(openingBody.operation, identity.operation);
          assert.ok(openingBody.input !== null && typeof openingBody.input === 'object' && 'device_id' in openingBody.input);
          assert.equal(openingBody.input.device_id, 'device-a');
          assert.equal(button('投屏进行中').disabled, true, '活动会话仍须防止重复打开');
          assert.equal(requests.filter((request) => request.path.endsWith('/recovery') && request.method === 'POST').length,
            manual ? 1 : 0, '打开动作不能追加全局恢复 POST');
          const current = services.runtime.mirroringStreaming.snapshot();
          await act(async () => {
            delayed.resolve(success(view({ recovering: true, last_report: report('busy') }), 'late-recovery-log'));
          });
          assert.equal(services.runtime.mirroringStreaming.snapshot(), current);
          assert.equal(requests.some((request) => request.path.includes('/device-actions') || request.path.endsWith('/jobs')), false);
        } finally {
          await reset();
          output.resolve(success({ session: identity, chunks: [], next_sequence: 0 }));
          delayed.resolve(success(view()));
          await services.dispose();
        }
      });
    }

    await t.test('分享页从链接设备核对，缺少 WebRTC 能力时手动恢复不自动提交 open', async () => {
      windowRef.location.hash = '#devices?share_device=shared-device&share_control=0';
      const posts: unknown[] = [];
      let opens = 0;
      let busy = true;
      let latest = view();
      const services = createProductServices({
        baseUrl: 'http://localhost',
        panelTarget: () => target,
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
          if (path === '/api/v2/sessions' && init?.method === 'POST') ++opens;
          throw new Error('不得自动重放分享投屏或设备动作');
        },
      });
      const { DeviceScreen } = await import('../src/pages/devices/screen/index.tsx');
      try {
        await act(async () => {
          root.render(createElement(DeviceScreen, { services, active: true }));
        });
        await showDetails();
        await settled(
          () => (target.textContent ?? '').includes('正在核对投屏资源'),
          '分享设备未消费恢复状态',
        );
        assert.match(target.textContent ?? '', /核对目标：shared-device/);
        assert.equal(button('核对并恢复').disabled, true);
        busy = false;
        await click('读取状态');
        await click('核对并恢复');
        assert.deepEqual(posts, [{ generation: 'g1', input: { device_id: 'shared-device' } }]);
        assert.match(target.textContent ?? '', /资源核对已通过/);
        assert.equal(services.webRtcMirroring.snapshot().session, null);
        assert.equal(opens, 0, 'WebRTC 能力缺失仍须阻止 open，与恢复忙门禁无关');
      } finally {
        await reset();
        await services.dispose();
        windowRef.location.hash = '';
      }
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    messages.dispose();
    windowRef.close();
    loader.deregister();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
