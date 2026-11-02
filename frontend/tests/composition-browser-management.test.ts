import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { registerBrowserManagementServices } from '../src/app/composition/browser-management.ts';
import type { BrowserManagementOptions } from '../src/app/composition/browser-management.ts';
import type { JsonValue } from '../src/plugin-sdk/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { deferred, installedPackage, requestUrl, success } from './fixtures.ts';

const signal = () => new AbortController().signal;
function fixture(transport?: typeof fetch) {
  const requests: string[] = [];
  const current = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      requests.push(path);
      if (transport) return transport(input, init);
      if (path === '/api/v2/plugin-packages/browser') return success([installedPackage('browser', { id: 'example' })]);
      if (path === '/api/v2/plugin-installations') return success([]);
      throw new Error('本单元禁止业务请求');
    },
  });
  const services = current.host.services;
  assert.ok(services);
  return {
    current, requests,
    register(options: Partial<BrowserManagementOptions> = {}) {
      return registerBrowserManagementServices({ host: current.host, extensions: current.webPlugins.extensions },
        { runtime: current, ...options });
    },
    async call(input: JsonValue, active = signal()) {
      return services.call({ id: 'host.browser-plugins', version: '1' }, input, active);
    },
  };
}
function object(value: JsonValue) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}

test('浏览器管理登记与快照不联网，未知目录不伪装为空的已确认目录', async () => {
  const f = fixture();
  try {
    f.register();
    const value = object((await f.call({ action: 'snapshot' })).data);
    assert.equal(value.snapshotVersion, 1);
    assert.equal(object(value.packages ?? null).known, false);
    assert.equal(object(value.installations ?? null).known, false);
    assert.deepEqual(f.requests, []);
  } finally { await f.current.dispose(); }
});

test('浏览器包启停只代理原控制器，未知参数不触发管理副作用', async () => {
  const f = fixture(), calls: string[] = [];
  try {
    f.register({ runtime: { ...f.current, pluginPackages: { ...f.current.pluginPackages,
      async enable(kind, id, active) {
        active.throwIfAborted(); calls.push(`enable:${kind}:${id}`);
        return { data: { id, generation: 1, state: 'loaded' }, logId: 'enable-log' };
      },
      async disable(kind, id, active) {
        active.throwIfAborted(); calls.push(`disable:${kind}:${id}`);
        return { data: null, logId: 'disable-log' };
      },
    } } });
    for (const input of [
      { action: 'setEnabled', source: 'package', id: 'example', enabled: true, force: true },
      { action: 'setEnabled', source: 'runtime', id: 'example', enabled: false },
      { action: 'setEnabled', source: 'package', id: '../other', enabled: true },
    ]) await assert.rejects(f.call(input));
    assert.deepEqual(calls, []);
    const enabled = await f.call({ action: 'setEnabled', source: 'package', id: 'example', enabled: true });
    assert.equal(enabled.logId, 'enable-log');
    const disabled = await f.call({ action: 'setEnabled', source: 'package', id: 'example', enabled: false });
    assert.equal(disabled.logId, 'disable-log');
    assert.deepEqual(calls, ['enable:browser:example', 'disable:browser:example']);
  } finally { await f.current.dispose(); }
});

test('浏览器管理取消未知写入只结束等待，不自动重放或把晚到结果当成功', async () => {
  const f = fixture(), late = deferred<void>(), controller = new AbortController();
  let calls = 0;
  try {
    f.register({ runtime: { ...f.current, pluginPackages: { ...f.current.pluginPackages, async enable(_kind, id) {
      calls++;
      await late.promise;
      return { data: { id, generation: 1, state: 'loaded' }, logId: 'late-log' };
    } } } });
    const pending = f.call({ action: 'setEnabled', source: 'package', id: 'example', enabled: true }, controller.signal);
    const rejected = assert.rejects(pending);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    controller.abort();
    await rejected;
    late.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    await f.call({ action: 'snapshot' });
    assert.equal(calls, 1);
  } finally { late.resolve(); await f.current.dispose(); }
});

test('浏览器管理保留原 API 日志及错误，不因失败永久封锁下一次显式操作', async () => {
  const f = fixture();
  let calls = 0;
  try {
    f.register({ runtime: { ...f.current, pluginPackages: { ...f.current.pluginPackages, async enable(_kind, id) {
      if (++calls === 1) throw new ApiError('http', 'browser_unavailable', '原控制器拒绝', 503, 'original-log', '1');
      return { data: { id, generation: 2, state: 'loaded' }, logId: 'new-log' };
    } } } });
    await assert.rejects(f.call({ action: 'setEnabled', source: 'package', id: 'example', enabled: true }),
      { code: 'browser_unavailable', logId: 'original-log', status: 503, retryAfter: '1' });
    assert.equal(calls, 1);
    assert.equal((await f.call({ action: 'setEnabled', source: 'package', id: 'example', enabled: true })).logId, 'new-log');
    assert.equal(calls, 2);
  } finally { await f.current.dispose(); }
});

test('随附启停交回原偏好入口，不擅自装载同名独立来源', async () => {
  const f = fixture(), calls: string[] = [];
  try {
    f.register({ bundled: {
      snapshot: () => [{ id: 'bundled', title: '随附能力', version: '1', phase: 'disabled', error: null }],
      setEnabled: async (id, enabled, active) => {
        active.throwIfAborted(); calls.push(`${id}:${enabled}`);
      },
      subscribe: () => () => undefined,
    } });
    const result = await f.call({ action: 'setEnabled', source: 'bundled', id: 'bundled', enabled: true });
    assert.equal(object(result.data).completed, true);
    assert.deepEqual(calls, ['bundled:true']);
    const snapshot = object((await f.call({ action: 'snapshot' })).data);
    assert.ok(Array.isArray(snapshot.bundled));
    assert.equal(object(snapshot.bundled[0] ?? null).source, 'bundled');
    assert.deepEqual(f.requests, [], '随附管理由原入口核对目录与偏好，不抢跑包读取或装载');
    await assert.rejects(f.call({ action: 'setEnabled', source: 'bundled', id: 'other', enabled: true }),
      { code: 'bundled_browser_unavailable' });
    assert.equal(calls.length, 1);
  } finally { await f.current.dispose(); }
});

test('完整安装与重试按原身份和修订代理，参数不符不提交 Job 或扫卸组件', async () => {
  const f = fixture(), calls: string[] = [];
  const installation = {
    id: 'release', name: '完整功能', description: '', summary: '', version: '1', revision: 'a'.repeat(64),
    enabled: true, status: 'enabled' as const, components: [],
  };
  try {
    f.register({ runtime: { ...f.current, pluginInstallations: { ...f.current.pluginInstallations,
      async setEnabled(id, revision, enabled, active) {
        active.throwIfAborted(); calls.push(`enable:${id}:${revision}:${enabled}`);
        return { ...installation, enabled };
      },
      async retryBrowser(id, revision, active) {
        active.throwIfAborted(); calls.push(`retry:${id}:${revision}`); return installation;
      },
      async uninstall(id, revision, active) {
        active.throwIfAborted(); calls.push(`remove:${id}:${revision}`);
      },
    } } });
    await assert.rejects(f.call({ action: 'installation', operation: 'disable', id: 'release', revision: 'wrong' }));
    assert.deepEqual(calls, []);
    await f.call({ action: 'installation', operation: 'disable', id: 'release', revision: installation.revision });
    await f.call({ action: 'installation', operation: 'retryBrowser', id: 'release', revision: installation.revision });
    await f.call({ action: 'installation', operation: 'remove', id: 'release', revision: installation.revision });
    assert.deepEqual(calls, [`enable:release:${installation.revision}:false`,
      `retry:release:${installation.revision}`, `remove:release:${installation.revision}`]);
    assert.deepEqual(f.requests, []);
  } finally { await f.current.dispose(); }
});

test('浏览器配置保持修订和字段错误，未知保存不自行应用或重载', async () => {
  const f = fixture(), calls: string[] = [];
  const view = {
    kind: 'browser' as const, id: 'example', definition: null, values: {}, revision: 'r1',
    appliedRevision: 'r0', pendingReload: true, compatible: false,
    fieldErrors: [{ path: '/name', message: '字段不符合约束' }], source: 'managed' as const,
  };
  try {
    f.register({ runtime: { ...f.current, pluginConfigurations: { ...f.current.pluginConfigurations,
      async get(target, active) { active.throwIfAborted(); calls.push(`get:${target.kind}:${target.id}`); return view; },
      async save(target, revision, values, active) {
        active.throwIfAborted(); calls.push(`save:${target.kind}:${target.id}:${revision}:${JSON.stringify(values)}`);
        return view;
      },
      async apply() { throw new Error('保存不能隐式应用'); },
    } } });
    const loaded = object((await f.call({ action: 'configuration', operation: 'get', id: 'example' })).data);
    assert.deepEqual(object(loaded.result ?? null).fieldErrors, view.fieldErrors);
    const saved = object((await f.call({ action: 'configuration', operation: 'save', id: 'example',
      revision: 'r1', values: { name: '草稿' } })).data);
    assert.equal(object(saved.result ?? null).pendingReload, true);
    assert.deepEqual(calls, ['get:browser:example', 'save:browser:example:r1:{"name":"草稿"}']);
    assert.deepEqual(f.requests, []);
  } finally { await f.current.dispose(); }
});

test('管理状态事件不借用调用信号，撤销适配即移除服务和订阅', async () => {
  const f = fixture();
  let notices = 0;
  const unsubscribe = f.current.host.extensions?.subscribeEvent('host.browser-plugins.changed', () => { notices++; });
  try {
    const release = f.register();
    const caller = new AbortController();
    await f.call({ action: 'snapshot' }, caller.signal);
    caller.abort();
    await f.current.pluginPackages.refresh('browser', f.current.host.signal);
    assert.ok(notices > 0, '一次快照调用结束不取消整个状态事件来源');
    await release();
    const stopped = notices;
    await f.current.pluginPackages.refresh('browser', f.current.host.signal);
    assert.equal(notices, stopped);
    await assert.rejects(f.call({ action: 'snapshot' }), { code: 'service_unavailable' });
  } finally { await unsubscribe?.(); await f.current.dispose(); }
});

test('完整安装所属浏览器组件不能通过独立包入口扫卸或启用', async () => {
  const f = fixture(async (input) => requestUrl(input).pathname === '/api/v2/plugin-installations'
    ? success([{
      id: 'paired', name: '配套安装', version: '1', description: '', revision: 'a'.repeat(64),
      enabled: true, status: 'enabled', installed_at: 1, tools: [], requirements: [],
      components: [{ id: 'example', kind: 'browser', version: '1', revision: 'a'.repeat(64),
        entry_path: 'dist/index.js', entry_url: null }],
    }]) : success([installedPackage('browser', { id: 'example' })]));
  let writes = 0;
  try {
    f.register({ runtime: { ...f.current, pluginPackages: { ...f.current.pluginPackages,
      async disable() { writes++; return { data: null, logId: null }; },
    } } });
    await assert.rejects(f.call({ action: 'setEnabled', source: 'package', id: 'example', enabled: false }),
      { code: 'installation_component_managed' });
    assert.equal(writes, 0);
    assert.equal(f.requests.length, 2);
  } finally { await f.current.dispose(); }
});

test('刷新管理目录复用已有在途读取，服务取消不撤销原读取', async () => {
  const response = deferred<Response>();
  const f = fixture(async (input) => requestUrl(input).pathname === '/api/v2/plugin-packages/browser'
    ? response.promise : success([]));
  const controller = new AbortController();
  const reading = f.current.pluginPackages.refresh('browser', f.current.host.signal);
  try {
    f.register();
    const pending = f.call({ action: 'refresh' }, controller.signal);
    const rejected = assert.rejects(pending);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.requests.filter((path) => path === '/api/v2/plugin-packages/browser').length, 1);
    controller.abort();
    await rejected;
    response.resolve(success([]));
    await reading;
    assert.equal(f.current.pluginPackages.snapshot('browser').error, null);
    assert.equal(f.current.pluginPackages.snapshot('browser').result?.data.length, 0);
  } finally {
    response.resolve(success([]));
    await Promise.allSettled([reading]);
    await f.current.dispose();
  }
});

test('历史清理诊断按公开错误字段返回，不以旧失败封锁管理快照', async () => {
  const f = fixture();
  try {
    f.register({ runtime: { ...f.current, webPlugins: { ...f.current.webPlugins,
      cleanupSnapshot: () => [{ id: 'old', generation: 1, error: {
        kind: 'http', code: 'cleanup_failed', message: '旧释放失败', status: 503,
        logId: 'cleanup-log', retryAfter: '2',
      } }],
    } } });
    const result = object((await f.call({ action: 'snapshot' })).data);
    assert.ok(Array.isArray(result.cleanup));
    assert.equal(object(object(result.cleanup[0] ?? null).error ?? null).logId, 'cleanup-log');
    assert.equal(object(object(result.cleanup[0] ?? null).error ?? null).retryAfter, '2');
    assert.deepEqual(f.requests, []);
  } finally { await f.current.dispose(); }
});

test('完整安装提交与更新复用原控制器，原来源和修订不被服务改写', async () => {
  const f = fixture(), calls: unknown[] = [];
  const value = { id: 'release', version: '1', revision: 'a'.repeat(64), enabled: true,
    name: '安装', summary: '', description: '', status: 'enabled' as const, components: [] };
  try {
    f.register({ runtime: { ...f.current, pluginInstallations: { ...f.current.pluginInstallations,
      async install(source, active) { active.throwIfAborted(); calls.push(['install', source]); return value; },
      async update(id, revision, source, active) {
        active.throwIfAborted(); calls.push(['update', id, revision, source]); return value;
      },
    } } });
    await assert.rejects(f.call({ action: 'installation', operation: 'install',
      source: { kind: 'market', sourceUrl: 'file:///invalid' } }));
    assert.deepEqual(calls, []);
    await f.call({ action: 'installation', operation: 'install', source: { kind: 'offline', artifactId: 'artifact-1' } });
    const source = { kind: 'market', sourceUrl: 'http://market.example/prefix', releaseId: 'release',
      version: '2', releaseDigest: 'b'.repeat(64) };
    await f.call({ action: 'installation', operation: 'update', id: 'release', revision: value.revision, source });
    assert.deepEqual(calls, [['install', { kind: 'offline', artifactId: 'artifact-1' }],
      ['update', 'release', value.revision, source]]);
    assert.deepEqual(f.requests, []);
  } finally { await f.current.dispose(); }
});

test('登记订阅中途失败立即撤销服务，不留下半初始化的公开能力', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.register({ bundled: {
      snapshot: () => [], setEnabled: async () => undefined,
      subscribe: () => { throw new Error('订阅登记失败'); },
    } }), /订阅登记失败/);
    await assert.rejects(f.call({ action: 'snapshot' }), { code: 'service_unavailable' });
    assert.deepEqual(f.requests, []);
  } finally { await f.current.dispose(); }
});

test('已撤销代理形式的旧清理错误不破坏当前目录或变成调用成功', async () => {
  const f = fixture(), proxy = Proxy.revocable({}, {});
  proxy.revoke();
  try {
    f.register({ runtime: { ...f.current, webPlugins: { ...f.current.webPlugins,
      cleanupSnapshot: () => [{ id: 'old', generation: 1, error: proxy.proxy }],
    } } });
    const snapshot = object((await f.call({ action: 'snapshot' })).data);
    assert.ok(Array.isArray(snapshot.cleanup));
    assert.equal(object(object(snapshot.cleanup[0] ?? null).error ?? null).message, '管理操作失败，详情未确认');
  } finally { await f.current.dispose(); }
});

test('浏览器包字节经公开产物引用交给原上传更新与移除控制器', async () => {
  const f = fixture(), calls: unknown[] = [];
  try {
    f.register({ runtime: { ...f.current,
      artifacts: { ...f.current.artifacts, async download(id, active) {
        active.throwIfAborted(); calls.push(['artifact', id]);
        return { data: new Blob(['archive']), logId: 'artifact-log' };
      } },
      pluginPackages: { ...f.current.pluginPackages,
        async upload(kind, content, mediaType, active, expected) {
          active.throwIfAborted();
          calls.push(['upload', kind, await content.text(), mediaType, expected]);
          return { data: installedPackage('browser', { id: 'new', version: '2' }), logId: 'upload-log' };
        },
        async update(kind, id, content, mediaType, active, version) {
          active.throwIfAborted();
          calls.push(['update', kind, id, await content.text(), mediaType, version]);
          return { data: installedPackage('browser', { id, version: '2' }), logId: 'update-log' };
        },
        async remove(kind, id, active) {
          active.throwIfAborted(); calls.push(['remove', kind, id]);
          return { data: installedPackage(kind, { id }), logId: 'remove-log' };
        },
      },
    } });
    assert.equal((await f.call({ action: 'package', operation: 'upload', id: 'new', artifactId: 'artifact-1',
      mediaType: 'application/zip', version: '2' })).logId, 'upload-log');
    assert.equal((await f.call({ action: 'package', operation: 'update', id: 'example', artifactId: 'artifact-2',
      mediaType: 'application/gzip', version: '2' })).logId, 'update-log');
    assert.equal((await f.call({ action: 'package', operation: 'remove', id: 'example' })).logId, 'remove-log');
    assert.deepEqual(calls, [
      ['artifact', 'artifact-1'], ['upload', 'browser', 'archive', 'application/zip', { id: 'new', version: '2' }],
      ['artifact', 'artifact-2'], ['update', 'browser', 'example', 'archive', 'application/gzip', '2'],
      ['remove', 'browser', 'example'],
    ]);
  } finally { await f.current.dispose(); }
});

test('浏览器包变更在无效媒体或已取消输入时不下载产物也不写入', async () => {
  const f = fixture();
  let downloads = 0;
  try {
    f.register({ runtime: { ...f.current, artifacts: { ...f.current.artifacts,
      async download() { downloads++; throw new Error('不应下载产物'); },
    } } });
    await assert.rejects(f.call({ action: 'package', operation: 'update', id: 'example', artifactId: 'artifact',
      mediaType: 'text/plain', version: '2' }));
    await assert.rejects(f.call({ action: 'package', operation: 'update', id: 'example', artifactId: 'artifact',
      mediaType: 'application/zip', version: '2' }, AbortSignal.abort()));
    assert.equal(downloads, 0);
    assert.deepEqual(f.requests, []);
  } finally { await f.current.dispose(); }
});

test('完整安装所属包在产物下载之前拒绝单包上传更新移除', async () => {
  const f = fixture(async (input) => requestUrl(input).pathname === '/api/v2/plugin-installations'
    ? success([{
      id: 'paired', name: '配套安装', version: '1', description: '', revision: 'a'.repeat(64),
      enabled: true, status: 'enabled', installed_at: 1, tools: [], requirements: [],
      components: [{ id: 'example', kind: 'browser', version: '1', revision: 'a'.repeat(64),
        entry_path: 'dist/index.js', entry_url: null }],
    }]) : success([installedPackage('browser', { id: 'example' })]));
  let downloads = 0, writes = 0;
  try {
    f.register({ runtime: { ...f.current,
      artifacts: { ...f.current.artifacts, async download() { downloads++; throw new Error('不应下载'); } },
      pluginPackages: { ...f.current.pluginPackages,
        async remove(kind, id) { writes++; return { data: installedPackage(kind, { id }), logId: null }; },
      },
    } });
    for (const operation of ['upload', 'update'])
      await assert.rejects(f.call({ action: 'package', operation, id: 'example', artifactId: 'artifact',
        mediaType: 'application/zip', version: '2' }), { code: 'installation_component_managed' });
    await assert.rejects(f.call({ action: 'package', operation: 'remove', id: 'example' }),
      { code: 'installation_component_managed' });
    assert.equal(downloads, 0);
    assert.equal(writes, 0);
  } finally { await f.current.dispose(); }
});

test('浏览器包产物读取取消后晚到不提交写入，下载失败保留原日志且不重放', async () => {
  const f = fixture(), response = deferred<{ data: Blob; logId: string | null }>();
  const controller = new AbortController();
  let downloads = 0, writes = 0;
  try {
    f.register({ runtime: { ...f.current,
      artifacts: { ...f.current.artifacts, async download() {
        downloads++;
        if (downloads === 1) return response.promise;
        throw new ApiError('http', 'artifact_failed', '原产物读取失败', 503, 'artifact-failure-log', '3');
      } },
      pluginPackages: { ...f.current.pluginPackages, async update(_kind, id) {
        writes++; return { data: installedPackage('browser', { id }), logId: 'write-log' };
      } },
    } });
    const input = { action: 'package', operation: 'update', id: 'example', artifactId: 'artifact',
      mediaType: 'application/zip', version: '2' };
    const pending = f.call(input, controller.signal), rejected = assert.rejects(pending);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(downloads, 1);
    controller.abort();
    await rejected;
    response.resolve({ data: new Blob(['late']), logId: 'late-download' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes, 0);
    await assert.rejects(f.call(input), {
      code: 'artifact_failed', logId: 'artifact-failure-log', status: 503, retryAfter: '3',
    });
    await f.call({ action: 'snapshot' });
    assert.equal(downloads, 2);
    assert.equal(writes, 0);
  } finally { response.resolve({ data: new Blob(), logId: null }); await f.current.dispose(); }
});
