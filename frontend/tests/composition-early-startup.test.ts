import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Dispose, HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import type { ProductPlatformServices } from '../src/app/product/platform-services.ts';
import type { OfficialPluginSource } from '../src/app/composition/manifest-sources.ts';
import type { OfficialPluginState } from '../src/app/composition/official-plugins.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { startShellSelection } from '../src/app/composition/shell-selection.ts';
import { SHELL_POINT } from '../src/app/composition/shell-host.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { deferred, requestUrl, success } from './fixtures.ts';

const key = 'early-startup.shell';

async function bounded<T>(value: Promise<T>, label: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([value, new Promise<never>((_accept, reject) => {
      deadline = setTimeout(() => reject(new Error(`${label}没有在本地单元期限内收敛`)), 500);
    })]);
  } finally { clearTimeout(deadline); }
}

function shellPlugin(id: string, activate?: (context: HostContext) => Promise<void>): WebPlugin {
  return {
    id, version: '1', apiVersion: 2, panels: [],
    async activate(context) {
      context.extensions?.points?.contribute({
        id: `${id}.shell`, point: SHELL_POINT, mode: 'replace',
        data: { pluginId: id, viewId: `${id}.root` },
      });
      await activate?.(context);
    },
  };
}

function fixture() {
  const cancellation = new AbortController();
  const runtime = createFrontendRuntime({
    baseUrl: 'http://early-startup.invalid', workspaceStorage: null, panelTarget: () => null,
    timeouts: { loadMs: 1000, mountMs: 100, cleanupMs: 100 },
    transport: async () => { throw new Error('早期选择单元不得访问网络或执行业务'); },
  });
  const points = runtime.host.extensions?.points ?? assert.fail('真实 runtime 缺少扩展点');
  const data = new Map<string, string>();
  const persistence = {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => { data.set(name, value); },
  };
  const releases: Dispose[] = [];
  const ids = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const resolveGates: (() => void)[] = [];
  function tracked<T>(value: Promise<T>): Promise<T> {
    pending.add(value);
    void value.then(() => pending.delete(value), () => pending.delete(value));
    return value;
  }
  async function add(id: string, activate?: (context: HostContext) => Promise<void>) {
    ids.add(id);
    runtime.bundledPlugins.register({ id, trusted: true, plugin: shellPlugin(id, activate) });
    return bounded(tracked(runtime.webPlugins.load(id)), `加载${id}`);
  }
  function gate() {
    const result = deferred<void>();
    const aborted = () => { result.resolve(); };
    cancellation.signal.addEventListener('abort', aborted, { once: true });
    resolveGates.push(() => {
      cancellation.signal.removeEventListener('abort', aborted);
      result.resolve();
    });
    return result;
  }
  function stalled(id: string) {
    const waiting = gate(), entered = deferred<void>();
    let completed = false;
    ids.add(id);
    runtime.bundledPlugins.register({
      id, trusted: true,
      async loader(signal) {
        entered.resolve();
        await waiting.promise;
        signal.throwIfAborted();
        return { id, version: '1', apiVersion: 2, panels: [] };
      },
    });
    const loading = tracked(runtime.webPlugins.load(id));
    void loading.then(() => { completed = true; }, () => { completed = true; });
    return { entered, loading, completed: () => completed };
  }
  function start(officialIds: readonly string[], ready?: (id: string, generation: number) => boolean) {
    const options = { key, persistence, ...(ready ? { providerReady: ready } : {}) };
    const release = startShellSelection(runtime.host, new Set(officialIds), options);
    releases.push(release);
    return release;
  }
  async function dispose() {
    for (const release of releases) await release();
    cancellation.abort();
    for (const resolveGate of resolveGates) resolveGate();
    try {
      await bounded(Promise.allSettled([...ids].map((id) => runtime.webPlugins.unload(id))), '撤销测试插件');
      await bounded(Promise.allSettled([...pending]), '释放未完成的测试装载');
    } finally { await bounded(runtime.dispose(), '销毁测试 runtime'); }
  }
  return { runtime, points, data, persistence, releases, add, gate, stalled, start, dispose };
}

test('选择订阅先于官方启动时恢复晚到的同一保存贡献，不等待其他慢业务加载',
  { timeout: 2500 }, async () => {
    const f = fixture();
    try {
      f.data.set(key, '"saved.shell"');
      f.start(['official']);
      const slow = f.stalled('unrelated_business');
      await bounded(slow.entered.promise, '进入无关慢业务加载器');
      await f.add('official');
      assert.equal(f.points.selected(SHELL_POINT), null, '已保存偏好不得被先到官方外壳抢占');
      await f.add('saved');
      assert.equal(f.points.selected(SHELL_POINT)?.id, 'saved.shell',
        '选择订阅在贡献出现前安装，保存的同一外壳晚到后应恢复');
      assert.equal(slow.completed(), false, '外壳已加载和选择时，不相关业务仍在等待');
      assert.equal(f.data.get(key), '"saved.shell"');
    } finally { await f.dispose(); }
  });

test('早期保存null或缺失贡献偏好时，晚到官方和第三方都不得自动抢占',
  { timeout: 2500 }, async () => {
    for (const preference of [null, 'missing.shell']) {
      const f = fixture();
      try {
        f.data.set(key, JSON.stringify(preference));
        f.start(['official']);
        await f.add('custom');
        await f.add('official');
        assert.equal(f.points.selected(SHELL_POINT), null);
        assert.equal(f.data.get(key), JSON.stringify(preference));
      } finally { await f.dispose(); }
    }
  });

test('早期无偏好只默认选择一次官方外壳，完成选择不等待无关慢业务',
  { timeout: 2500 }, async () => {
    const f = fixture();
    try {
      f.start(['official', 'official_later']);
      const slow = f.stalled('unrelated_business');
      await bounded(slow.entered.promise, '进入无关慢业务加载器');
      await f.add('custom');
      assert.equal(f.points.selected(SHELL_POINT), null, '第三方不能替代首次官方选择');
      await f.add('official');
      assert.equal(f.points.selected(SHELL_POINT)?.id, 'official.shell',
        '早期订阅必须在第一项官方外壳完成后选择，不等待整批插件完成');
      assert.equal(slow.completed(), false);
      await f.add('official_later');
      assert.equal(f.points.selected(SHELL_POINT)?.id, 'official.shell', '默认选择只执行一次');
    } finally { await f.dispose(); }
  });

test('真实manager激活未完成时providerReady阻止选择，loaded事件触发重新匹配',
  { timeout: 2500 }, async () => {
    const f = fixture();
    try {
      const activation = f.gate(), contributed = deferred<void>();
      f.start(['official'], (id, generation) => f.runtime.webPlugins.diagnosticSnapshot()
        .some((entry) => entry.id === id && entry.generation === generation && entry.state === 'loaded'));
      const loading = f.add('official', async (context) => {
        contributed.resolve();
        await activation.promise;
        context.signal.throwIfAborted();
      });
      void loading.catch(() => undefined);
      await bounded(contributed.promise, '官方外壳登记贡献');
      assert.equal(f.points.list(SHELL_POINT).filter((entry) => entry.state === 'active').length, 1);
      assert.equal(f.points.selected(SHELL_POINT), null, '登记了贡献但激活尚未完成，不能提前选用');
      activation.resolve();
      await loading;
      assert.equal(f.points.selected(SHELL_POINT)?.id, 'official.shell',
        '贡献目录未再变化时，也必须由真实loaded事件重新匹配');
    } finally { await f.dispose(); }
  });

test('既有实时选择和无候选期间的显式选择都优先于晚到官方',
  { timeout: 2500 }, async () => {
    for (const beforeStart of [true, false]) {
      const f = fixture();
      try {
        if (beforeStart) await f.add('custom');
        if (beforeStart) f.points.select(SHELL_POINT, 'custom.shell');
        f.start(['official']);
        if (!beforeStart) {
          await f.add('custom');
          f.points.select(SHELL_POINT, 'custom.shell');
        }
        await f.add('official');
        assert.equal(f.points.selection?.(SHELL_POINT), 'custom.shell');
        assert.equal(f.points.selected(SHELL_POINT)?.id, 'custom.shell');
      } finally { await f.dispose(); }
    }
  });

test('早期选择订阅释放后不再因晚到官方自动匹配或持久化',
  { timeout: 2500 }, async () => {
    const f = fixture();
    try {
      const release = f.start(['official']);
      await release();
      await f.add('official');
      assert.equal(f.points.selected(SHELL_POINT), null);
      f.points.select(SHELL_POINT, 'official.shell');
      assert.equal(f.data.has(key), false, '旧启动订阅释放后不再写入选择偏好');
    } finally { await f.dispose(); }
  });

test('startWorkspace两桥失败仍独立启动官方外壳，不等待慢业务或管理defaults',
  { timeout: 5000 }, async () => {
    const parser = registerCompositionStartupImports();
    try {
      assert.deepEqual(parser.diagnostics, []);
      const { createProductPlatformServices } = await import('../src/app/product/platform-services.ts');
      const { startWorkspace } = await import('../src/app/composition/start-workspace.ts');
      const cancellation = new AbortController(), waiting = deferred<void>();
      const slowEntered = deferred<void>(), shellLoaded = deferred<void>();
      const requests: string[] = [], bridgeAttempts: string[] = [];
      const reports: { label: string; error: unknown }[] = [];
      const sources: readonly OfficialPluginSource[] = [
        { id: 'startup_shell', version: '1', title: '首屏外壳',
          loader: async () => shellPlugin('startup_shell') },
        { id: 'slow_business', version: '1', title: '无关慢业务',
          async loader(signal) {
            slowEntered.resolve();
            await waiting.promise;
            signal.throwIfAborted();
            return { id: 'slow_business', version: '1', apiVersion: 2, panels: [] };
          } },
      ];
      const directoryPaths = ['/api/v2/plugin-packages/browser', '/api/v2/plugin-installations'];
      const services = createProductPlatformServices({
        baseUrl: 'http://workspace-startup.invalid', panelTarget: () => null, workspaceStorage: null,
        timeouts: { loadMs: 1500, mountMs: 100, cleanupMs: 100 },
        officialPlugins: { sources },
        transport: async (input, init) => {
          const path = requestUrl(input).pathname;
          requests.push(path);
          assert.ok((init?.method ?? 'GET') === 'GET' && directoryPaths.includes(path),
            '真实启动只允许本单元的安装目录只读夹具，不访问网络或设备');
          return success([]);
        },
      });
      const official = services.officialPlugins ?? assert.fail('真实服务缺少官方目录装配');
      const defaultsBefore = services.pluginDefaults.snapshot();
      const points = services.runtime.host.extensions?.points ?? assert.fail('真实服务缺少扩展点');
      const releaseLoaded = services.runtime.host.extensions?.subscribeEvent('host.plugins.changed', ({ data }) => {
        if (data && typeof data === 'object' && !Array.isArray(data) &&
          'pluginId' in data && data.pluginId === 'startup_shell' &&
          'stage' in data && data.stage === 'loaded') shellLoaded.resolve();
      });
      let batch: Promise<readonly OfficialPluginState[]> | undefined;
      let batchCompleted = false;
      // 只在兼容桥的登记边界注入失败；官方目录及其manager仍使用真实服务。
      const startupServices: ProductPlatformServices = {
        ...services,
        runtime: {
          ...services.runtime,
          bundledPlugins: {
            ...services.runtime.bundledPlugins,
            register(entry) {
              bridgeAttempts.push(entry.id);
              throw new Error('测试兼容桥登记失败');
            },
          },
        },
        officialPlugins: {
          ...official,
          start(signal) {
            const current = official.start(signal);
            batch = current;
            void current.then(() => { batchCompleted = true; }, () => { batchCompleted = true; });
            return current;
          },
        },
      };
      let releaseStartup: Dispose = () => {};
      try {
        releaseStartup = startWorkspace({
          services: startupServices, officialIds: new Set(['startup_shell']), signal: cancellation.signal,
          selection: { key },
          report(label, error) { reports.push({ label, error }); },
        });
        await bounded(Promise.all([shellLoaded.promise, slowEntered.promise]), '首屏外壳完成且慢业务仍挂起');
        assert.equal(points.selected(SHELL_POINT)?.id, 'startup_shell.shell',
          '选择订阅必须在官方启动之前就位，外壳先loaded即可完成首屏选择');
        assert.equal(services.runtime.webPlugins.diagnosticSnapshot().find((entry) =>
          entry.id === 'startup_shell')?.state, 'loaded');
        assert.equal(batchCompleted, false, '首屏不能等待整批官方插件或慢业务完成');
        assert.equal(bridgeAttempts.length, 2);
        assert.equal(reports.length, 2);
        assert.ok(reports.every((entry) => entry.label.length > 0 &&
          entry.error instanceof Error && entry.error.message === '测试兼容桥登记失败'));
        assert.deepEqual(services.pluginDefaults.snapshot(), defaultsBefore,
          '工作区启动不自行启动、等待或管理pluginDefaults');
        assert.deepEqual([...new Set(requests)].sort(), [...directoryPaths].sort());
      } finally {
        cancellation.abort();
        waiting.resolve();
        await releaseStartup();
        await releaseLoaded?.();
        try {
          await bounded(Promise.allSettled([
            ...(batch ? [batch] : []),
            services.runtime.webPlugins.unload('startup_shell'),
            services.runtime.webPlugins.unload('slow_business'),
          ]), '撤销真实服务中的启动插件');
        } finally { await bounded(services.dispose(), '销毁真实启动服务'); }
      }
    } finally { parser.dispose(); }
  });

test('真实工作区启动不等待慢默认服务器，随附调试器仍经原管理器独立完成',
  { timeout: 5000 }, async () => {
    const parser = registerCompositionStartupImports();
    const browser = new JSDOM('<body></body>', { url: 'http://localhost:5173' });
    const response = deferred<Response>(), serverEntered = deferred<void>(), debuggerEntered = deferred<void>();
    const cancellation = new AbortController();
    let releaseStartup: Dispose = () => {};
    try {
      const { createProductPlatformServices } = await import('../src/app/product/platform-services.ts');
      const { startWorkspace } = await import('../src/app/composition/start-workspace.ts');
      const reports: string[] = [], requests: string[] = [];
      const services = createProductPlatformServices({
        baseUrl: 'http://localhost:7031', panelTarget: () => null, workspaceStorage: null,
        debugger: { document: browser.window.document },
        bundledDebugger: { browserOrigin: 'http://localhost:5173', load: async () => ({
          id: 'deviceforge_debugger', version: '0.1.0', apiVersion: 2, panels: [],
          async activate() { debuggerEntered.resolve(); },
        }) },
        transport: async (input, init) => {
          const path = requestUrl(input).pathname; requests.push(path);
          assert.equal(init?.method ?? 'GET', 'GET', '本单元只允许读取安装和运行目录');
          if (path === '/api/v2/plugins') { serverEntered.resolve(); return response.promise; }
          assert.ok(['/api/v2/plugin-packages/server', '/api/v2/plugin-packages/browser', '/api/v2/plugin-installations'].includes(path));
          return success([]);
        },
      });
      const defaults = services.pluginDefaults.start(cancellation.signal);
      void defaults.catch(() => undefined);
      try {
        await bounded(serverEntered.promise, '默认服务器运行目录开始读取');
        releaseStartup = startWorkspace({ services, officialIds: new Set(), signal: cancellation.signal,
          selection: { key }, report: (label) => { reports.push(label); },
        });
        await bounded(debuggerEntered.promise, '慢默认启用期间调试器激活');
        await bounded(services.bundledDebugger?.start(cancellation.signal) ?? Promise.reject(new Error('缺少随附调试器')), '调试器就绪');
        assert.equal(services.pluginDefaults.snapshot().phase, 'running');
        assert.equal(services.runtime.webPlugins.snapshot().find((entry) => entry.id === 'deviceforge_debugger')?.state, 'loaded');
        assert.deepEqual(reports, []);
        assert.equal(requests.some((path) => /debugger\/|\/jobs/.test(path)), false, '显示入口不创建调试会话或业务任务');
      } finally {
        cancellation.abort(); response.resolve(success([]));
        await releaseStartup(); await defaults.catch(() => undefined); await services.dispose();
      }
    } finally { response.resolve(success([])); browser.window.close(); parser.dispose(); }
  });
