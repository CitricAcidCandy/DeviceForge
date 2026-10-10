import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient } from '../src/shared/api/index.ts';
import type { ApiClient } from '../src/shared/api/index.ts';
import { createTasks } from '../src/features/tasks/index.ts';
import { createServerPlugins } from '../src/features/server-plugins/index.ts';
import { createPluginPackages } from '../src/features/plugin-packages/index.ts';
import { deferred, signal } from './fixtures.ts';

interface Reader {
  run: () => Promise<unknown>;
  other: () => Promise<unknown>;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}
const cases: readonly { title: string; create: (client: ApiClient) => Reader }[] = [
  { title: '任务', create(client) {
    const tasks = createTasks(client);
    return { run: () => tasks.select('original', signal()), other: () => tasks.get('other', signal()),
      subscribe: tasks.subscribe, dispose: tasks.dispose };
  } },
  { title: '服务器插件', create(client) {
    const plugins = createServerPlugins(client, async () => {});
    return { run: () => plugins.refresh(signal()), other: () => plugins.load('other', signal()),
      subscribe: plugins.subscribe, dispose: plugins.dispose };
  } },
  { title: '插件包', create(client) {
    const packages = createPluginPackages(client, {
      enableServer: async () => { throw new Error('关闭后不得启用'); },
      disableServer: async () => { throw new Error('关闭后不得停用'); },
      prepareServerRemoval: async () => {},
      enableBrowser: async () => { throw new Error('关闭后不得启用'); },
      disableBrowser: async () => {}, forgetBrowser: async () => {},
    });
    return { run: () => packages.refresh('server', signal()),
      other: () => packages.upload('server', new Blob(['fixture']), 'application/gzip', signal()),
      subscribe: (listener) => packages.subscribe('server', listener), dispose: packages.dispose };
  } },
];

for (const item of cases) test(`${item.title}销毁先关闭准入，取消回调重入不通知或发新请求`, async () => {
  const entered = deferred<void>();
  const reentries: Promise<PromiseSettledResult<unknown>[]>[] = [];
  let requests = 0;
  let notices = 0;
  let reader: Reader;
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (_url, init) => {
    ++requests;
    assert.ok(init?.signal);
    init.signal.addEventListener('abort', () => {
      reentries.push(Promise.allSettled([reader.run(), reader.other()]));
    }, { once: true });
    entered.resolve();
    return new Promise<Response>(() => {});
  } });
  reader = item.create(client);
  reader.subscribe(() => { ++notices; });
  const waiting = reader.run();
  const failure = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  notices = 0;
  reader.dispose();
  await failure;
  const outcomes = await Promise.all(reentries);
  assert.equal(outcomes.length, 1);
  assert.ok(outcomes[0]?.every((result) => result.status === 'rejected'));
  assert.equal(requests, 1);
  assert.equal(notices, 0);
  reader.dispose();
});

for (const activeKind of ['server', 'browser'] as const) test(`插件包销毁取消${activeKind}读取时，两类目录均拒绝重入刷新和订阅`, async () => {
  const entered = deferred<void>();
  const reentries: Promise<PromiseSettledResult<unknown>[]>[] = [];
  let requests = 0;
  let notices = 0;
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (_url, init) => {
    ++requests;
    assert.ok(init?.signal);
    init.signal.addEventListener('abort', () => {
      // server 先关闭时，browser 的资源对象尚未关闭，模块准入仍须统一拒绝。
      for (const kind of ['server', 'browser'] as const) {
        assert.throws(() => packages.subscribe(kind, () => { ++notices; }), /插件包已关闭/);
      }
      reentries.push(Promise.allSettled([
        packages.refresh('server', signal()), packages.refresh('browser', signal()),
      ]));
    }, { once: true });
    entered.resolve();
    return new Promise<Response>(() => {});
  } });
  const packages = createPluginPackages(client, {
    enableServer: async () => { throw new Error('关闭后不得启用'); },
    disableServer: async () => { throw new Error('关闭后不得停用'); },
    prepareServerRemoval: async () => {},
    enableBrowser: async () => { throw new Error('关闭后不得启用'); },
    disableBrowser: async () => {}, forgetBrowser: async () => {},
  });
  packages.subscribe('server', () => { ++notices; });
  packages.subscribe('browser', () => { ++notices; });
  const waiting = packages.refresh(activeKind, signal());
  const failure = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  notices = 0;
  packages.dispose();
  await failure;
  const outcomes = await Promise.all(reentries);
  assert.equal(outcomes.length, 1);
  assert.ok(outcomes[0]?.every((result) => result.status === 'rejected'));
  assert.equal(requests, 1);
  assert.equal(notices, 0);
  packages.dispose();
});
