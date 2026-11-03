import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginDefaults } from '../src/features/plugin-defaults/index.ts';
import { createPluginPackages } from '../src/features/plugin-packages/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { ApiResult, PluginInfo } from '../src/services/api/index.ts';
import type { WebPluginRuntimeInfo } from '../src/plugin-sdk/index.ts';
import { deferred, installedPackage, plugin, requestUrl, signal, success } from './fixtures.ts';

function fixture() {
  const delayed = deferred<ApiResult<PluginInfo>>();
  const entered = deferred<void>();
  const browser = new Map<string, WebPluginRuntimeInfo>();
  const calls: string[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (input, init) => {
    const path = requestUrl(input).pathname;
    assert.equal(init?.method, 'GET', '本夹具只读取包目录，不发送业务或部署写入');
    if (path === '/api/v2/plugin-packages/server')
      return success([installedPackage('server', { id: 'slow-server' })], 'server-directory-log');
    assert.equal(path, '/api/v2/plugin-packages/browser');
    return success(['browser-one', 'browser-two'].map((id) => installedPackage('browser', { id })), 'browser-directory-log');
  } });
  const packages = createPluginPackages(client, {
    enableServer: async (id) => { calls.push(`enable:server:${id}`); entered.resolve(); return delayed.promise; },
    disableServer: async (id) => { calls.push(`disable:server:${id}`); return { data: plugin({ id, state: 'unloaded' }), logId: 'disable-log' }; },
    prepareServerRemoval: async () => { throw new Error('启用不应准备删除服务器包'); },
    enableBrowser: async (pkg) => {
      calls.push(`enable:browser:${pkg.id}`);
      const loaded: WebPluginRuntimeInfo = { id: pkg.id, generation: 1, state: 'loaded' };
      browser.set(pkg.id, loaded); return loaded;
    },
    disableBrowser: async (id) => { calls.push(`disable:browser:${id}`); browser.delete(id); },
    forgetBrowser: async () => { throw new Error('启用不应删除浏览器来源'); },
  });
  const defaults = createPluginDefaults({ packages, serverPlugins: {
    refresh: async () => ({ data: [], logId: 'running-log' }),
  }, browserPlugins: { snapshot: () => [...browser.values()] } });
  return { delayed, entered, calls, browser, packages, defaults };
}

test('真实默认启用与包队列贯通，慢服务器不阻塞两个浏览器插件且同类停用继续排队', async () => {
  const f = fixture();
  const waiting = f.defaults.start(signal());
  void waiting.catch(() => undefined);
  let stopping: Promise<unknown> | null = null;
  try {
    await f.entered.promise;
    stopping = f.packages.disable('server', 'slow-server', signal());
    await new Promise((done) => setImmediate(done));
    assert.deepEqual([...f.browser.keys()], ['browser-one', 'browser-two'], '真实包队列仍不能把浏览器排到慢服务器后');
    assert.equal(f.calls.includes('disable:server:slow-server'), false, '同类停用仍须等前一启用收敛');
    assert.equal(f.defaults.snapshot().phase, 'running');
    f.delayed.resolve({ data: plugin({ id: 'slow-server' }), logId: 'server-enable-log' });
    const result = await waiting;
    await stopping;
    assert.equal(result.phase, 'completed');
    assert.equal(result.results.filter((item) => item.status === 'enabled').length, 3);
    assert.equal(f.calls.filter((item) => item.startsWith('disable:')).length, 1);
  } finally {
    f.defaults.dispose();
    f.delayed.resolve({ data: plugin({ id: 'slow-server' }), logId: 'late-log' });
    await Promise.allSettled([waiting, stopping]); f.packages.dispose();
  }
});

test('真实包启用失败只推进所属队列，浏览器已成功结果保留且无自动重放', async () => {
  const f = fixture();
  const waiting = f.defaults.start(signal());
  void waiting.catch(() => undefined);
  try {
    await f.entered.promise;
    await new Promise((done) => setImmediate(done));
    assert.equal(f.browser.size, 2);
    f.delayed.reject(new ApiError('http', 'activation_failed', '本次服务器启用失败', 503, 'server-failure-log'));
    const result = await waiting;
    assert.equal(result.results.find((item) => item.id === 'slow-server')?.logId, 'server-failure-log');
    assert.equal(result.results.filter((item) => item.status === 'enabled').length, 2);
    await f.packages.disable('server', 'slow-server', signal());
    await f.defaults.start(signal());
    assert.equal(f.calls.filter((item) => item === 'enable:server:slow-server').length, 1);
    assert.equal(f.calls.filter((item) => item.startsWith('enable:browser:')).length, 2);
  } finally {
    f.defaults.dispose();
    f.delayed.resolve({ data: plugin({ id: 'slow-server' }), logId: 'late-log' });
    await waiting.catch(() => undefined); f.packages.dispose();
  }
});
