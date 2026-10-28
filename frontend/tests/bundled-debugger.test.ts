import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createBundledDebugger } from '../src/app/product/bundled-debugger.ts';
import type { WebPlugin } from '../src/plugin-sdk/index.ts';
import { deferred, installedPackage, success } from './fixtures.ts';
import { release } from './plugin-installations-fixture.ts';

const id = 'deviceforge_debugger';
const signal = () => new AbortController().signal;
function fixture(storage = new Map<string, string>(), origin = 'http://localhost:7031') {
  const document = new JSDOM('<body></body>', { url: origin }).window.document;
  let calls = 0, loads = 0, releases = 0;
  let packages: ReturnType<typeof installedPackage>[] = [];
  let installations: ReturnType<typeof release>[] = [];
  const runtime = createFrontendRuntime({ baseUrl: origin, panelTarget: () => null,
    debugger: { document }, esmImporter: async () => ({ default: { ...plugin, version: '0.2.0' } }),
    transport: async input => {
      calls++;
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/api/v2/plugin-installations') return success(installations.map(item => ({
        ...item, installed_at: 1, failure: null, requirements: [], tools: [],
        components: item.components.map(component => ({ id: component.id, kind: component.kind,
          version: component.version, revision: component.revision, entry_path: component.entryPath, entry_url: component.entryUrl })),
      })));
      if (path === '/api/v2/plugin-packages/browser') return success(packages);
      if (path === `/api/v2/plugin-dependencies/browser/${id}`) return success({
        target: { kind: 'browser', id }, revision: 'a'.repeat(64), ready: true, dependencies: [],
      });
      throw new Error(`不应由随附插件发起此请求：${path}`);
    },
  });
  const plugin: WebPlugin = { id, version: '0.1.0', apiVersion: 2, panels: [],
    async activate(context) { context.onDispose(() => { releases++; }); } };
  const controller = createBundledDebugger({ runtime, baseUrl: origin, browserOrigin: origin,
    load: async () => { loads++; return { default: plugin }; },
    persistence: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } },
  });
  return { runtime, controller, storage,
    counts: () => ({ calls, loads, releases }),
    installed() { packages = [installedPackage('browser', { id, version: '0.2.0', api_version: 2 })]; },
    disabledInstallation() { installations = [{ ...release(), enabled: false, status: 'installed',
      components: [{ id, kind: 'browser', version: '0.1.0', entryPath: 'dist/index.js', revision: 'a'.repeat(64), entryUrl: null }] }]; },
    async dispose() { controller.dispose(); await runtime.dispose(); document.defaultView?.close(); },
  };
}

test('随附调试器构造无请求，空部署启动经原管理器加载且不自动采集', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.counts(), { calls: 0, loads: 0, releases: 0 });
    await f.controller.start(signal());
    assert.equal(f.controller.snapshot().phase, 'loaded');
    assert.equal(f.runtime.webPlugins.snapshot().find(item => item.id === id)?.state, 'loaded');
    assert.equal(f.runtime.debugger?.snapshot().instanceId, null);
    assert.equal(f.counts().calls, 2, '仅查询原目录，不自动打开调试会话、桥或 UI 树');
    await f.controller.start(signal());
    assert.equal(f.counts().loads, 1);
  } finally { await f.dispose(); }
});

test('停用撤销原作用域，刷新后保持停用，显式启用可恢复', async () => {
  const storage = new Map<string, string>();
  const f = fixture(storage);
  try {
    await f.controller.start(signal());
    await f.controller.setEnabled(false, signal());
    assert.equal(f.runtime.webPlugins.snapshot().length, 0);
    assert.equal(f.counts().releases, 1);
    await f.controller.start(signal());
    assert.equal(f.counts().loads, 1);
  } finally { await f.dispose(); }
  const next = fixture(storage);
  try {
    await next.controller.start(signal());
    assert.equal(next.controller.snapshot().phase, 'disabled');
    assert.equal(next.counts().loads, 0);
    next.runtime.webPlugins.register({ id: 'independent', trusted: true, plugin: {
      id: 'independent', version: '1.0.0', apiVersion: 2, panels: [], contributions: {
        commands: [{ id: 'independent.ping', title: '独立命令', execute: async () => ({ data: null, logId: null }) }],
      },
    } });
    await next.runtime.webPlugins.load('independent');
    assert.equal(next.controller.snapshot().phase, 'disabled', '无关插件加载不能隐藏停用后的恢复入口');
    await next.controller.setEnabled(true, signal());
    assert.equal(next.controller.snapshot().phase, 'loaded');
  } finally { await next.dispose(); }
});

test('已安装独立同名包或已停用完整安装时不重复登记、不覆盖安装意图', async () => {
  for (const mode of ['standalone', 'disabled-release']) {
    const f = fixture();
    try {
      if (mode === 'standalone') f.installed(); else f.disabledInstallation();
      await f.controller.start(signal());
      assert.equal(f.controller.snapshot().phase, 'external');
      assert.equal(f.counts().loads, 0);
      assert.equal(f.runtime.webPlugins.snapshot().length, 0);
    } finally { await f.dispose(); }
  }
});

test('局域网页面不装配本机调试器，不影响普通运行实例', async () => {
  const f = fixture(new Map(), 'http://192.168.1.12:7031');
  try {
    await f.controller.start(signal());
    assert.equal(f.controller.snapshot().phase, 'unavailable');
    assert.deepEqual(f.counts(), { calls: 0, loads: 0, releases: 0 });
  } finally { await f.dispose(); }
});

test('随附插件启用后原导入层可接管同名包，旧控制器不能停掉独立安装', async () => {
  const f = fixture();
  try {
    await f.controller.start(signal());
    const before = f.runtime.webPlugins.snapshot()[0]?.generation;
    f.installed();
    await f.runtime.pluginPackages.refresh('browser', signal());
    // 使用原包启用用例，替换来源前应撤销随附代次。
    await f.runtime.pluginPackages.enable('browser', id, signal());
    assert.notEqual(f.runtime.webPlugins.snapshot()[0]?.generation, before);
    assert.equal(f.counts().releases, 1);
    await assert.rejects(f.controller.setEnabled(false, signal()), /原安装入口/);
    assert.equal(f.runtime.webPlugins.snapshot()[0]?.state, 'loaded');
  } finally { await f.dispose(); }
});

test('加载取消不会留下一代随附插件，晚到模块不复活', async () => {
  const f = fixture();
  const waiting = deferred<unknown>();
  const controller = createBundledDebugger({ runtime: f.runtime, baseUrl: 'http://localhost:7031',
    browserOrigin: 'http://localhost:7031', load: () => waiting.promise });
  const caller = new AbortController();
  try {
    const started = controller.start(caller.signal);
    while (!f.runtime.webPlugins.snapshot().length) await new Promise(resolve => setImmediate(resolve));
    caller.abort();
    await assert.rejects(started);
    waiting.resolve({ default: { id, version: '0.1.0', apiVersion: 2, panels: [] } });
    assert.equal(f.runtime.webPlugins.snapshot().length, 0);
  } finally { controller.dispose(); await f.dispose(); }
});
