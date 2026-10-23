import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginDefaults } from '../src/features/plugin-defaults/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { ApiResult, PackageInfo, PackageKind, PluginInfo } from '../src/services/api/index.ts';
import type { WebPluginRuntimeInfo } from '../src/plugin-sdk/index.ts';
import { deferred, installedPackage, plugin, signal } from './fixtures.ts';
import type { PluginDefaultsGateway } from '../src/features/plugin-defaults/index.ts';
import { release } from './plugin-installations-fixture.ts';

function fixture(installations?: PluginDefaultsGateway['installations']) {
  const packages: Record<PackageKind, PackageInfo[]> = { server: [], browser: [] };
  const server = new Map<string, PluginInfo>();
  const browser = new Map<string, WebPluginRuntimeInfo>();
  const requests: string[] = [];
  const failures = new Set<string>();
  let hold: Promise<ApiResult<PluginInfo | WebPluginRuntimeInfo>> | null = null;
  let directoryFailed = false;
  const feature = createPluginDefaults({
    ...(installations ? { installations } : {}),
    packages: {
      refresh: async (kind) => {
        requests.push(`list:${kind}`);
        if (kind === 'server' && directoryFailed)
          throw new ApiError(
            'http',
            'server_directory_failed',
            '服务器安装目录不可读',
            503,
            'directory-failed-log',
          );
        return { data: packages[kind], logId: `${kind}-directory-log` };
      },
      enable: async (kind, id) => {
        requests.push(`enable:${kind}:${id}`);
        if (hold) return hold;
        if (failures.has(id))
          throw new ApiError('http', 'activation_failed', '受控启用失败', 502, `${id}-failed-log`);
        if (kind === 'server') {
          const loaded = plugin({ id });
          server.set(id, loaded);
          return { data: loaded, logId: `${id}-enable-log` };
        }
        const loaded: WebPluginRuntimeInfo = { id, generation: 1, state: 'loaded' };
        browser.set(id, loaded);
        return { data: loaded, logId: `${id}-enable-log` };
      },
    },
    serverPlugins: {
      refresh: async () => {
        requests.push('running:server');
        return { data: [...server.values()], logId: 'running-log' };
      },
    },
    browserPlugins: { snapshot: () => [...browser.values()] },
  });
  return {
    feature,
    packages,
    server,
    browser,
    requests,
    failures,
    hold(value: Promise<ApiResult<PluginInfo | WebPluginRuntimeInfo>>) {
      hold = value;
    },
    failDirectory(value: boolean) {
      directoryFailed = value;
    },
  };
}

test('默认启用构造零请求，同轮start共用等待，运行代次与CLI现有启用不重载', async () => {
  const f = fixture();
  f.packages.server.push(
    installedPackage('server', { id: 'existing' }),
    installedPackage('server', { id: 'new-server' }),
  );
  f.packages.browser.push(installedPackage('browser', { id: 'browser-a' }));
  f.server.set('existing', plugin({ id: 'existing', generation: 'existing-generation' }));
  f.server.set('cli-native', plugin({ id: 'cli-native' }));
  assert.equal(f.requests.length, 0);
  const first = f.feature.start(signal());
  assert.equal(f.feature.start(signal()), first);
  const result = await first;
  assert.equal(result.phase, 'completed');
  assert.deepEqual(
    f.requests.filter((item) => item.startsWith('enable:')),
    ['enable:server:new-server', 'enable:browser:browser-a'],
  );
  assert.equal(f.server.get('existing')?.generation, 'existing-generation');
  assert.equal(result.results.find((item) => item.id === 'cli-native')?.status, 'already_enabled');
  const requests = f.requests.length;
  f.server.delete('new-server');
  f.browser.delete('browser-a');
  await f.feature.start(signal());
  assert.equal(f.requests.length, requests, '当前实例主动停用后不会默认再次恢复');
  f.feature.dispose();
});

test('逐包失败隔离并保留日志，显式失败重试不重新启用此前成功后被停用者', async () => {
  const f = fixture();
  f.packages.server.push(
    installedPackage('server', { id: 'bad' }),
    installedPackage('server', { id: 'good' }),
  );
  f.packages.browser.push(installedPackage('browser', { id: 'browser-good' }));
  f.failures.add('bad');
  const first = await f.feature.start(signal());
  assert.equal(first.results.find((item) => item.id === 'bad')?.logId, 'bad-failed-log');
  assert.equal(first.results.find((item) => item.id === 'good')?.status, 'enabled');
  assert.equal(first.results.find((item) => item.id === 'browser-good')?.status, 'enabled');
  f.failures.delete('bad');
  f.server.delete('good');
  const before = f.requests.length;
  await f.feature.retryFailures(signal());
  assert.deepEqual(
    f.requests.slice(before).filter((item) => item.startsWith('enable:')),
    ['enable:server:bad'],
  );
  assert.equal(f.server.has('good'), false);
  const second = await f.feature.restart(signal());
  assert.equal(second.round, 2);
  assert.equal(f.server.has('good'), true, '用户显式新一轮可以重新启用');
  f.feature.dispose();
});

test('目录失败不阻断另一类包，可明确重试失败目录', async () => {
  const f = fixture();
  f.packages.server.push(installedPackage('server', { id: 'server-a' }));
  f.packages.browser.push(installedPackage('browser', { id: 'browser-a' }));
  f.failDirectory(true);
  const first = await f.feature.start(signal());
  assert.equal(first.results.find((item) => item.id === null)?.logId, 'directory-failed-log');
  assert.equal(f.browser.has('browser-a'), true);
  f.failDirectory(false);
  await f.feature.retryFailures(signal());
  assert.equal(f.server.has('server-a'), true);
  assert.equal(
    f.feature.snapshot().results.some((item) => item.status === 'failed'),
    false,
  );
  f.feature.dispose();
});

test('失败目录重试保留此前已运行后主动停用的包', async () => {
  const f = fixture();
  f.packages.server.push(
    installedPackage('server', { id: 'previously-running' }),
    installedPackage('server', { id: 'unobserved' }),
  );
  f.server.set('previously-running', plugin({ id: 'previously-running' }));
  f.failDirectory(true);
  await f.feature.start(signal());
  f.server.delete('previously-running');
  f.failDirectory(false);
  const before = f.requests.length;
  await f.feature.retryFailures(signal());
  assert.deepEqual(
    f.requests.slice(before).filter((item) => item.startsWith('enable:')),
    ['enable:server:unobserved'],
  );
  assert.equal(f.server.has('previously-running'), false);
  f.feature.dispose();
});

test('排空和未确认清理保留失败，已加载浏览器不重复激活', async () => {
  const f = fixture();
  f.packages.server.push(
    installedPackage('server', { id: 'draining' }),
    installedPackage('server', { id: 'unclean' }),
  );
  f.packages.browser.push(installedPackage('browser', { id: 'existing-browser' }));
  f.server.set('draining', plugin({ id: 'draining', state: 'draining' }));
  f.server.set('unclean', plugin({ id: 'unclean', cleanup_failed: true }));
  f.browser.set('existing-browser', { id: 'existing-browser', generation: 7, state: 'loaded' });
  const result = await f.feature.start(signal());
  assert.equal(result.results.filter((item) => item.status === 'failed').length, 2);
  assert.equal(
    f.requests.some((item) => item.startsWith('enable:')),
    false,
  );
  assert.equal(f.browser.get('existing-browser')?.generation, 7);
  f.feature.dispose();
});

test('取消结束忽略信号的等待，晚到结果不发布，同轮不自动重试副作用', async () => {
  const f = fixture();
  f.packages.server.push(installedPackage('server', { id: 'held' }));
  const delayed = deferred<ApiResult<PluginInfo | WebPluginRuntimeInfo>>();
  f.hold(delayed.promise);
  const controller = new AbortController();
  const waiting = f.feature.start(controller.signal);
  const rejected = assert.rejects(
    waiting,
    (error: unknown) => error instanceof ApiError && error.kind === 'cancelled',
  );
  await new Promise((done) => setImmediate(done));
  controller.abort();
  await rejected;
  const cancelled = f.feature.snapshot();
  assert.equal(cancelled.phase, 'cancelled');
  delayed.resolve({ data: plugin({ id: 'held' }), logId: 'late-log' });
  await new Promise((done) => setImmediate(done));
  assert.equal(f.feature.snapshot(), cancelled);
  const requests = f.requests.length;
  await f.feature.start(signal());
  assert.equal(f.requests.length, requests);
  f.feature.dispose();
});

test('销毁取消在途启用与订阅，不通知晚到结果', async () => {
  const f = fixture();
  f.packages.browser.push(installedPackage('browser', { id: 'held-browser' }));
  const delayed = deferred<ApiResult<PluginInfo | WebPluginRuntimeInfo>>();
  f.hold(delayed.promise);
  let notifications = 0;
  f.feature.subscribe(() => {
    ++notifications;
  });
  const waiting = f.feature.start(signal());
  const rejected = assert.rejects(
    waiting,
    (error: unknown) => error instanceof ApiError && error.kind === 'cancelled',
  );
  await new Promise((done) => setImmediate(done));
  f.feature.dispose();
  await rejected;
  const count = notifications;
  delayed.reject(new Error('已接住的晚到失败'));
  await new Promise((done) => setImmediate(done));
  assert.equal(notifications, count);
  assert.equal(f.feature.snapshot().phase, 'closed');
  await assert.rejects(f.feature.start(signal()), /已关闭/);
});

test('统一安装的停用意图优先于旧包默认启用，名称相同的不同类型也精确匹配', async () => {
  let restored = 0;
  const f = fixture({ restore: async () => { ++restored; }, snapshot: () => ({ pending: false, error: null,
    result: { data: [release(false)], logId: 'installation-log' } }) });
  f.packages.server.push(installedPackage('server', { id: 'example-server' }), installedPackage('server', { id: 'example-browser' }));
  f.packages.browser.push(installedPackage('browser', { id: 'example-browser' }));
  const result = await f.feature.start(signal());
  assert.equal(restored, 1);
  assert.deepEqual(f.requests.filter((value) => value.startsWith('enable:')), ['enable:server:example-browser']);
  assert.equal(result.results.some((value) => value.id === 'example-server'), false);
  assert.equal(result.results.some((value) => value.kind === 'browser' && value.id === 'example-browser'), false);
  f.feature.dispose();
});

test('部分统一安装浏览器恢复失败后保留目录与日志，继续非所属包且不重放统一服务器启用', async () => {
  const f = fixture({ restore: async () => { throw new ApiError('http', 'browser_failed', '浏览器恢复失败', 500, 'restore-log'); },
    snapshot: () => ({ pending: false, error: null, result: { data: [release(true)], logId: 'installation-log' } }) });
  f.packages.server.push(installedPackage('server', { id: 'example-server' }), installedPackage('server', { id: 'independent' }));
  f.packages.browser.push(installedPackage('browser', { id: 'example-browser' }));
  const result = await f.feature.start(signal());
  assert.equal(result.results.find((value) => value.id === null)?.logId, 'restore-log');
  assert.deepEqual(f.requests.filter((value) => value.startsWith('enable:')), ['enable:server:independent']);
  f.feature.dispose();
});

test('统一安装目录不可读时不绕过意图启动任何底层包', async () => {
  const f = fixture({ restore: async () => { throw new ApiError('http', 'directory_failed', '统一目录不可读', 503, 'installation-failed-log'); },
    snapshot: () => ({ pending: false, result: null, error: new Error('统一目录不可读') }) });
  f.packages.server.push(installedPackage('server', { id: 'unknown-owner' }));
  const result = await f.feature.start(signal());
  assert.equal(result.phase, 'completed');
  assert.equal(result.results[0]?.logId, 'installation-failed-log');
  assert.deepEqual(f.requests, []);
  f.feature.dispose();
});
