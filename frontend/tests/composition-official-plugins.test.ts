import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestPluginSources } from '../src/app/composition/manifest-sources.ts';
import { createOfficialPlugins } from '../src/app/composition/official-plugins.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import type { WebPlugin } from '../src/plugin-sdk/index.ts';
import { deferred, failure, installedPackage, requestUrl, success } from './fixtures.ts';

function manifest(id: string) {
  return {
    manifest_version: 1, id, version: '1.2.3', name: `示例 ${id}`, description: '公开组合测试插件',
    components: [{ kind: 'browser', files: ['dist'], entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } } }],
  };
}
const plugin = (identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin => ({
  ...identity, panels: [],
  async activate(context) {
    context.ui?.register({ pages: [{
      id: `${identity.id}.page`, title: identity.id, route: `/${identity.id}`,
      mount: async () => () => {},
    }] });
  },
});
const packagesPath = '/api/v2/plugin-packages/browser';
const installationsPath = '/api/v2/plugin-installations';
function runtime(transport?: typeof fetch) {
  return createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: transport ?? (async (input) => {
      const path = requestUrl(input).pathname;
      if (path === packagesPath || path === installationsPath) return success([]);
      throw new Error('随附插件登记不应自动读取业务数据');
    }),
  });
}
function exampleSources(...ids: string[]) {
  return manifestPluginSources(
    Object.fromEntries(ids.map((id) => [`${id}/manifest.json`, manifest(id)])),
    Object.fromEntries(ids.map((id) => [`${id}/src/index.ts`, async () => ({ default: plugin })])),
  ).sources;
}
const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });
function stalledCatalogRuntime(
  current: ReturnType<typeof runtime>, late: Promise<void>, signals: AbortSignal[],
): ReturnType<typeof runtime> {
  return {
    ...current,
    pluginPackages: { ...current.pluginPackages, refresh(kind, signal) {
      signals.push(signal);
      const reading = current.pluginPackages.refresh(kind, signal);
      void reading.catch(() => undefined);
      return late.then(() => reading);
    } },
    pluginInstallations: { ...current.pluginInstallations, refresh(signal) {
      signals.push(signal);
      const reading = current.pluginInstallations.refresh(signal);
      void reading.catch(() => undefined);
      return late.then(() => reading);
    } },
  };
}

for (const pendingPath of [packagesPath, installationsPath]) {
  test(`目录 ${pendingPath} 尚在读取时恢复启用不得遮盖同 ID 独立安装`, async () => {
    const response = deferred<Response>(), entered = deferred<void>();
    const requests: string[] = [], signals: AbortSignal[] = [];
    const current = runtime(async (input, init) => {
      const path = requestUrl(input).pathname;
      requests.push(path);
      if (path === pendingPath) {
        assert.ok(init?.signal);
        signals.push(init.signal);
        entered.resolve();
        return response.promise;
      }
      if (path === packagesPath || path === installationsPath) return success([]);
      throw new Error('不应发生业务请求');
    });
    const official = createOfficialPlugins({
      runtime: current, sources: exampleSources('example'), baseUrl: 'http://127.0.0.1:7031',
    });
    const reading = pendingPath === packagesPath
      ? current.pluginPackages.refresh('browser', current.host.signal)
      : current.pluginInstallations.refresh(current.host.signal);
    const enabled = official.setEnabled('example', true, current.host.signal);
    const rejected = assert.rejects(enabled, /独立安装/);
    void rejected.catch(() => undefined);
    try {
      await entered.promise;
      await turn();
      assert.equal(current.bundledPlugins.has('example'), false, '未知目录不能作为随附来源登记依据');
      assert.deepEqual(current.webPlugins.snapshot(), [], '目录读取未完不能启动随附版本');
      assert.equal(requests.filter((path) => path === pendingPath).length, 1, '不得用新刷新取消已有读取');
      assert.equal(signals[0]?.aborted, false);
      response.resolve(success(pendingPath === packagesPath
        ? [installedPackage('browser', { id: 'example' })]
        : [{
          id: 'paired-release', version: '1.0', revision: 'a'.repeat(64), name: '独立配套插件',
          description: '已独立安装', enabled: false, status: 'installed', installed_at: 1,
          tools: [], requirements: [], components: [{
            id: 'example', kind: 'browser', version: '1.0', revision: 'a'.repeat(64),
            entry_path: 'dist/index.js', entry_url: null,
          }],
        }]));
      await reading;
      await rejected;
      assert.equal(official.snapshot()[0]?.phase, 'external');
      assert.equal(current.bundledPlugins.has('example'), false);
      assert.deepEqual(current.webPlugins.snapshot(), []);
    } finally {
      response.resolve(success([]));
      await Promise.allSettled([reading, rejected]);
      official.dispose();
      await current.dispose();
    }
  });
}

test('目录尚未知时并发启用不同插件，共享一次只读核对而不串行装卸', async () => {
  const response = deferred<Response>(), requests: string[] = [];
  const current = runtime(async (input) => {
    const path = requestUrl(input).pathname;
    requests.push(path);
    if (path === packagesPath) return response.promise;
    if (path === installationsPath) return success([]);
    throw new Error('不应发生业务请求');
  });
  const official = createOfficialPlugins({
    runtime: current, sources: exampleSources('first', 'second'), baseUrl: 'http://127.0.0.1:7031',
  });
  const first = official.setEnabled('first', true, current.host.signal);
  const second = official.setEnabled('second', true, current.host.signal);
  try {
    await turn();
    assert.deepEqual(requests.sort(), [packagesPath, installationsPath].sort());
    assert.equal(current.bundledPlugins.has('first'), false);
    assert.equal(current.bundledPlugins.has('second'), false);
    response.resolve(success([]));
    await Promise.all([first, second]);
    assert.deepEqual(official.snapshot().map((entry) => entry.phase), ['loaded', 'loaded']);
    assert.equal(current.host.ui?.catalog().pages.length, 2);
  } finally {
    response.resolve(success([]));
    await Promise.allSettled([first, second]);
    official.dispose();
    await current.dispose();
  }
});

test('旧空缓存不能遮盖正在刷新的安装目录', async () => {
  const response = deferred<Response>();
  let refreshing = false, packageReads = 0;
  const current = runtime(async (input) => {
    const path = requestUrl(input).pathname;
    if (path === packagesPath) {
      packageReads++;
      return refreshing ? response.promise : success([]);
    }
    if (path === installationsPath) return success([]);
    throw new Error('不应发生业务请求');
  });
  const official = createOfficialPlugins({
    runtime: current, sources: exampleSources('example'), baseUrl: 'http://127.0.0.1:7031',
  });
  await current.pluginPackages.refresh('browser', current.host.signal);
  await current.pluginInstallations.refresh(current.host.signal);
  refreshing = true;
  const reading = current.pluginPackages.refresh('browser', current.host.signal);
  const enabled = official.setEnabled('example', true, current.host.signal);
  const rejected = assert.rejects(enabled, /独立安装/);
  void rejected.catch(() => undefined);
  try {
    await turn();
    assert.equal(current.pluginPackages.snapshot('browser').result?.data.length, 0);
    assert.equal(current.bundledPlugins.has('example'), false);
    assert.equal(packageReads, 2, '已有空缓存也不能再次刷新取消在途核对');
    response.resolve(success([installedPackage('browser', { id: 'example' })]));
    await reading;
    await rejected;
    assert.equal(official.snapshot()[0]?.phase, 'external');
  } finally {
    response.resolve(success([]));
    await Promise.allSettled([reading, rejected]);
    official.dispose();
    await current.dispose();
  }
});

test('目录未确认的新停用意图撤销旧启用等待，目录恢复后不重放旧加载', async () => {
  const response = deferred<Response>(), values = new Map<string, string>();
  const current = runtime(async (input) => {
    const path = requestUrl(input).pathname;
    if (path === packagesPath) return response.promise;
    if (path === installationsPath) return success([]);
    throw new Error('不应发生业务请求');
  });
  const official = createOfficialPlugins({
    runtime: current, sources: exampleSources('example'), baseUrl: 'http://127.0.0.1:7031',
    persistence: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } },
  });
  const starting = official.start(current.host.signal);
  try {
    await turn();
    const stopping = official.setEnabled('example', false, current.host.signal);
    await starting;
    assert.equal(values.get('deviceforge.official:http://127.0.0.1:7031:example'), 'disabled');
    assert.equal(current.bundledPlugins.has('example'), false);
    response.resolve(success([]));
    await stopping;
    assert.equal(official.snapshot()[0]?.phase, 'disabled');
    assert.equal(current.bundledPlugins.has('example'), false);
    assert.deepEqual(current.webPlugins.snapshot(), []);
  } finally {
    response.resolve(success([]));
    official.dispose();
    await Promise.allSettled([starting]);
    await current.dispose();
  }
});

test('目录未知时停用也不能卸载已经运行的同 ID 独立插件', async () => {
  const response = deferred<Response>();
  let unloads = 0;
  const current = runtime(async (input) => {
    const path = requestUrl(input).pathname;
    if (path === packagesPath) return response.promise;
    if (path === installationsPath) return success([]);
    throw new Error('不应发生业务请求');
  });
  current.webPlugins.register({
    id: 'example', trusted: true, plugin: plugin({ id: 'example', version: 'independent', apiVersion: 2 }),
  });
  await current.webPlugins.load('example');
  const official = createOfficialPlugins({
    runtime: { ...current, webPlugins: { ...current.webPlugins, async unload(id) {
      unloads++;
      await current.webPlugins.unload(id);
    } } },
    sources: exampleSources('example'), baseUrl: 'http://127.0.0.1:7031',
  });
  const rejected = assert.rejects(official.setEnabled('example', false, current.host.signal), /独立安装/);
  void rejected.catch(() => undefined);
  try {
    await turn();
    assert.equal(unloads, 0);
    assert.equal(current.webPlugins.diagnosticSnapshot()[0]?.version, 'independent');
    response.resolve(success([installedPackage('browser', { id: 'example', version: 'independent' })]));
    await rejected;
    assert.equal(unloads, 0);
    assert.equal(official.snapshot()[0]?.phase, 'external');
    assert.equal(current.webPlugins.diagnosticSnapshot()[0]?.version, 'independent');
    assert.equal(current.host.ui?.catalog().pages.length, 1);
  } finally {
    response.resolve(success([]));
    await Promise.allSettled([rejected]);
    official.dispose();
    await current.dispose();
  }
});

test('目录失败保留日志且不登记来源，后续读取恢复不自动重放启停', async () => {
  let broken = true, reads = 0;
  const current = runtime(async (input) => {
    const path = requestUrl(input).pathname;
    if (path === packagesPath) {
      reads++;
      return broken ? failure('directory_unavailable', 503) : success([]);
    }
    if (path === installationsPath) return success([]);
    throw new Error('不应发生业务请求');
  });
  const official = createOfficialPlugins({
    runtime: current, sources: exampleSources('first', 'second'), baseUrl: 'http://127.0.0.1:7031',
  });
  try {
    await assert.rejects(official.setEnabled('first', true, current.host.signal),
      { code: 'directory_unavailable', logId: 'log-error' });
    assert.equal(reads, 1, '一次核对失败不能偷偷循环读取或启用');
    assert.equal(current.bundledPlugins.has('first'), false);
    assert.deepEqual(current.webPlugins.snapshot(), []);
    broken = false;
    await current.pluginPackages.refresh('browser', current.host.signal);
    await turn();
    assert.equal(current.bundledPlugins.has('first'), false);
    assert.equal(official.snapshot().find((entry) => entry.id === 'first')?.phase, 'failed');
    await official.setEnabled('second', true, current.host.signal);
    assert.equal(official.snapshot().find((entry) => entry.id === 'second')?.phase, 'loaded');
    assert.equal(reads, 2, '确认过的目录直接复用，不追加读取或永久封锁独立项');
    await official.setEnabled('first', true, current.host.signal);
    assert.equal(official.snapshot().find((entry) => entry.id === 'first')?.phase, 'loaded');
  } finally { official.dispose(); await current.dispose(); }
});

test('单个调用取消只结束自己的核对，不取消共享目录或污染另一插件结果', async () => {
  const response = deferred<Response>(), controller = new AbortController();
  const requests: string[] = [], signals: AbortSignal[] = [];
  const current = runtime(async (input, init) => {
    const path = requestUrl(input).pathname;
    requests.push(path);
    if (path === packagesPath) {
      assert.ok(init?.signal);
      signals.push(init.signal);
      return response.promise;
    }
    if (path === installationsPath) return success([]);
    throw new Error('不应发生业务请求');
  });
  const reading = current.pluginPackages.refresh('browser', current.host.signal);
  const official = createOfficialPlugins({
    runtime: current, sources: exampleSources('first', 'second'), baseUrl: 'http://127.0.0.1:7031',
  });
  const rejected = assert.rejects(official.setEnabled('first', true, controller.signal), /撤销|取消/);
  const second = official.setEnabled('second', true, current.host.signal);
  void rejected.catch(() => undefined);
  try {
    await turn();
    controller.abort();
    await rejected;
    assert.equal(signals[0]?.aborted, false, '共享的目录请求仍由原发起者管理');
    assert.equal(current.bundledPlugins.has('first'), false);
    response.resolve(success([]));
    await reading;
    await second;
    assert.equal(requests.filter((path) => path === packagesPath).length, 1);
    assert.equal(official.snapshot().find((entry) => entry.id === 'second')?.phase, 'loaded');
    assert.equal(current.bundledPlugins.has('first'), false, '迟到目录结果不能补发已撤销加载');
  } finally {
    response.resolve(success([]));
    await Promise.allSettled([reading, rejected, second]);
    official.dispose();
    await current.dispose();
  }
});

test('目录永不返回时固定十五秒结束核对，迟到读取不能补发加载或卸载', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const response = deferred<void>(), requests: string[] = [], signals: AbortSignal[] = [];
  const current = runtime(async (input, init) => {
    const path = requestUrl(input).pathname;
    if (path !== packagesPath && path !== installationsPath) throw new Error('不应发生业务请求');
    requests.push(path);
    assert.ok(init?.signal);
    signals.push(init.signal);
    await response.promise;
    return success([]);
  });
  const official = createOfficialPlugins({
    runtime: current, sources: exampleSources('example'), baseUrl: 'http://127.0.0.1:7031',
  });
  const rejected = assert.rejects(official.setEnabled('example', true, current.host.signal), /期限/);
  void rejected.catch(() => undefined);
  try {
    await turn();
    assert.deepEqual(requests.sort(), [packagesPath, installationsPath].sort());
    t.mock.timers.tick(15_000);
    await rejected;
    assert.equal(official.snapshot()[0]?.phase, 'failed');
    assert.equal(current.bundledPlugins.has('example'), false);
    assert.ok(signals.every((signal) => signal.aborted), '本次发起的目录读取也须有界退出');
    response.resolve();
    await turn();
    assert.deepEqual(current.webPlugins.snapshot(), []);
    assert.equal(current.bundledPlugins.has('example'), false);
    assert.equal(requests.length, 2, '超时之后不自动刷新或重放业务操作');
  } finally {
    response.resolve();
    official.dispose();
    await Promise.allSettled([rejected]);
    await current.dispose();
  }
});

test('关闭随附装配立即撤销自有目录等待和读取，不留下迟到启用', async () => {
  const response = deferred<void>(), signals: AbortSignal[] = [];
  const current = runtime(async (input, init) => {
    const path = requestUrl(input).pathname;
    if (path !== packagesPath && path !== installationsPath) throw new Error('不应发生业务请求');
    assert.ok(init?.signal);
    signals.push(init.signal);
    await response.promise;
    return success([]);
  });
  const official = createOfficialPlugins({
    runtime: current, sources: exampleSources('example'), baseUrl: 'http://127.0.0.1:7031',
  });
  const rejected = assert.rejects(official.setEnabled('example', true, current.host.signal), /撤销|取消/);
  void rejected.catch(() => undefined);
  try {
    await turn();
    official.dispose();
    await rejected;
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
    response.resolve();
    await turn();
    assert.equal(current.bundledPlugins.has('example'), false);
    assert.deepEqual(current.webPlugins.snapshot(), []);
  } finally {
    response.resolve();
    official.dispose();
    await Promise.allSettled([rejected]);
    await current.dispose();
  }
});

test('目录清理补验：刷新忽略取消时 dispose 同步收回全部三个自有定时器', async (t) => {
  const late = deferred<void>(), signals: AbortSignal[] = [];
  const current = runtime(async (input) => {
    const path = requestUrl(input).pathname;
    if (path !== packagesPath && path !== installationsPath) throw new Error('不应发生业务请求');
    await late.promise;
    return success([]);
  });
  const official = createOfficialPlugins({
    runtime: stalledCatalogRuntime(current, late.promise, signals),
    sources: exampleSources('example'), baseUrl: 'http://127.0.0.1:7031',
  });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  let owned: ReturnType<typeof setTimeout>[] = [];
  const rejected = assert.rejects(official.setEnabled('example', true, current.host.signal), /撤销|取消/);
  void rejected.catch(() => undefined);
  try {
    await turn();
    owned = scheduled.mock.calls.flatMap((call) => call.result === undefined ? [] : [call.result]);
    assert.equal(owned.length, 3, '只跟踪一个核对等待及两个目录读取');
    official.dispose();
    assert.ok(owned.every((handle) => cleared.mock.calls.some((call) => call.arguments[0] === handle)),
      '不等刷新 Promise 交付，就应同步释放所有自有定时器');
    assert.ok(signals.every((signal) => signal.aborted));
    await rejected;
    late.resolve();
    await turn();
    assert.equal(current.bundledPlugins.has('example'), false);
    assert.deepEqual(current.webPlugins.snapshot(), []);
  } finally {
    official.dispose();
    for (const handle of owned) clearTimeout(handle);
    late.resolve();
    await Promise.allSettled([rejected]);
    await current.dispose();
  }
});

test('目录清理补验：刷新忽略取消时到期也释放读取登记与全部定时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const late = deferred<void>(), signals: AbortSignal[] = [];
  const current = runtime(async (input) => {
    const path = requestUrl(input).pathname;
    if (path !== packagesPath && path !== installationsPath) throw new Error('不应发生业务请求');
    await late.promise;
    return success([]);
  });
  const official = createOfficialPlugins({
    runtime: stalledCatalogRuntime(current, late.promise, signals),
    sources: exampleSources('example'), baseUrl: 'http://127.0.0.1:7031',
  });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  let owned: ReturnType<typeof setTimeout>[] = [];
  const rejected = assert.rejects(official.setEnabled('example', true, current.host.signal), /期限/);
  void rejected.catch(() => undefined);
  try {
    await turn();
    owned = scheduled.mock.calls.flatMap((call) => call.result === undefined ? [] : [call.result]);
    assert.equal(owned.length, 3);
    t.mock.timers.tick(15_000);
    await rejected;
    assert.ok(owned.every((handle) => cleared.mock.calls.some((call) => call.arguments[0] === handle)));
    assert.ok(signals.every((signal) => signal.aborted));
    const released = cleared.mock.calls.length;
    official.dispose();
    assert.equal(cleared.mock.calls.length, released, '到期登记已经收回，关闭时无需再次清理');
    late.resolve();
    await turn();
    assert.equal(current.bundledPlugins.has('example'), false);
    assert.deepEqual(current.webPlugins.snapshot(), []);
  } finally {
    official.dispose();
    for (const handle of owned) clearTimeout(handle);
    late.resolve();
    await Promise.allSettled([rejected]);
    await current.dispose();
  }
});

test('目录清理补验：同步刷新抛错立即取消自有读取并清理登记与定时器', async (t) => {
  const current = runtime(), signals: AbortSignal[] = [];
  const official = createOfficialPlugins({
    runtime: { ...current, pluginPackages: { ...current.pluginPackages, refresh(_kind, signal) {
      signals.push(signal);
      throw new Error('同步目录拒绝');
    } } },
    sources: exampleSources('example'), baseUrl: 'http://127.0.0.1:7031',
  });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  let owned: ReturnType<typeof setTimeout>[] = [];
  try {
    await assert.rejects(official.setEnabled('example', true, current.host.signal), /同步目录拒绝/);
    owned = scheduled.mock.calls.flatMap((call) => call.result === undefined ? [] : [call.result]);
    assert.equal(owned.length, 2, '首个读取同步失败后不启动第二个目录请求');
    assert.ok(owned.every((handle) => cleared.mock.calls.some((call) => call.arguments[0] === handle)));
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, true);
    const released = cleared.mock.calls.length;
    official.dispose();
    assert.equal(cleared.mock.calls.length, released, '同步失败已经移除读取登记');
    assert.equal(current.bundledPlugins.has('example'), false);
    assert.deepEqual(current.webPlugins.snapshot(), []);
  } finally {
    official.dispose();
    for (const handle of owned) clearTimeout(handle);
    await current.dispose();
  }
});

test('开发清单扫描注入唯一身份，新增页面不需宿主路由或业务清单', async () => {
  const sources = manifestPluginSources({
    '../../../plugins/new/manifest.json': manifest('new_business'),
  }, { '../../../plugins/new/src/index.ts': async () => ({ default: plugin }) });
  assert.equal(sources.diagnostics.length, 0);
  const current = runtime();
  const official = createOfficialPlugins({ runtime: current, sources: sources.sources, baseUrl: 'http://127.0.0.1:7031' });
  try {
    await official.start(current.host.signal);
    assert.equal(official.snapshot()[0]?.phase, 'loaded');
    assert.equal(current.host.ui?.catalog().pages[0]?.route, '/new_business');
    assert.equal(current.webPlugins.diagnosticSnapshot()[0]?.version, '1.2.3');
  } finally { official.dispose(); await current.dispose(); }
});

test('开发装配与发布包装共用单清单配置，不要求插件源码重复声明', async () => {
  const declaration = manifest('configured');
  const component = declaration.components[0];
  assert.ok(component);
  const configuration = {
    version: 1, schema: { type: 'object', properties: { homeRoute: { type: 'string' } } },
    defaults: { homeRoute: '/custom' }, apply_policy: 'plugin_reload',
  };
  const directory = manifestPluginSources({ 'configured/manifest.json': {
    ...declaration, components: [{ ...component, plugin: { configuration } }],
  } }, { 'configured/src/index.ts': async () => ({ default: plugin }) });
  assert.deepEqual(directory.diagnostics, []);
  const source = directory.sources[0];
  assert.ok(source);
  const resolved = await source.loader(new AbortController().signal);
  assert.ok(resolved !== null && typeof resolved === 'object' && 'configuration' in resolved);
  assert.deepEqual(resolved.configuration, configuration);
  assert.equal('configuration' in plugin({ id: 'configured', version: '1.2.3', apiVersion: 2 }), false,
    '开发入口不能靠源码内再抄一份配置换取通过');
});

test('重复清单或错误来源明确诊断，不按扫描顺序抢占', () => {
  const sources = manifestPluginSources({
    'a/manifest.json': manifest('same'),
    'b/manifest.json': manifest('same'),
    'bad/manifest.json': { id: 'invalid' },
  }, {
    'a/src/index.ts': async () => ({ default: plugin }),
    'b/src/index.ts': async () => ({ default: plugin }),
  });
  assert.equal(sources.sources.length, 0);
  assert.equal(sources.diagnostics.length, 2);
  assert.ok(sources.diagnostics.some((entry) => /相同浏览器组件/.test(entry.message)));
});

test('一项随附插件失败不封锁其他页面，停用重启保留且不恢复内置业务', async () => {
  const storage = new Map<string, string>();
  const directory = manifestPluginSources({
    'good/manifest.json': manifest('good'),
    'bad/manifest.json': manifest('bad'),
  }, {
    'good/src/index.ts': async () => ({ default: plugin }),
    'bad/src/index.ts': async () => { throw new Error('插件代码不可用'); },
  });
  const persistence = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  const current = runtime();
  const official = createOfficialPlugins({
    runtime: current, sources: directory.sources, baseUrl: 'http://127.0.0.1:7031', persistence,
  });
  try {
    await official.start(current.host.signal);
    assert.equal(official.snapshot().find((entry) => entry.id === 'bad')?.phase, 'failed');
    assert.equal(official.snapshot().find((entry) => entry.id === 'good')?.phase, 'loaded');
    await official.setEnabled('good', false, current.host.signal);
    assert.equal(current.host.ui?.catalog().pages.length, 0);
  } finally { official.dispose(); await current.dispose(); }
  const next = runtime();
  const restarted = createOfficialPlugins({
    runtime: next, sources: directory.sources.filter((source) => source.id === 'good'),
    baseUrl: 'http://127.0.0.1:7031', persistence,
  });
  try {
    await restarted.start(next.host.signal);
    assert.equal(restarted.snapshot()[0]?.phase, 'disabled');
    assert.equal(next.host.ui?.catalog().pages.length, 0);
    await restarted.setEnabled('good', true, next.host.signal);
    assert.equal(next.host.ui?.catalog().pages.length, 1);
  } finally { restarted.dispose(); await next.dispose(); }
});

test('工厂导出身份与开发清单不符时拒绝，不自行更改插件身份', async () => {
  const directory = manifestPluginSources({ 'a/manifest.json': manifest('expected') }, {
    'a/src/index.ts': async () => ({ default: () => plugin({ id: 'unexpected', version: '1.2.3', apiVersion: 2 }) }),
  });
  const source = directory.sources[0];
  assert.ok(source);
  await assert.rejects(source.loader(new AbortController().signal), /身份/);
});

test('旧启用回执晚于新停用返回，不覆盖当前状态或持久偏好', async () => {
  const current = runtime();
  const entered = deferred<void>(), late = deferred<void>();
  const directory = manifestPluginSources({ 'a/manifest.json': manifest('example') }, {
    'a/src/index.ts': async () => ({ default: plugin }),
  });
  const values = new Map<string, string>();
  const original = current.webPlugins.load;
  const official = createOfficialPlugins({
    runtime: { ...current, webPlugins: { ...current.webPlugins, async load(id) {
      const result = await original(id); entered.resolve(); await late.promise; return result;
    } } },
    sources: directory.sources, baseUrl: 'http://127.0.0.1:7031',
    persistence: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } },
  });
  try {
    const starting = official.start(current.host.signal);
    await entered.promise;
    await official.setEnabled('example', false, current.host.signal);
    late.resolve(); await starting;
    assert.equal(official.snapshot()[0]?.phase, 'disabled');
    assert.equal(values.get('deviceforge.official:http://127.0.0.1:7031:example'), 'disabled');
    assert.equal(current.webPlugins.snapshot().length, 0);
  } finally { late.resolve(); official.dispose(); await current.dispose(); }
});
