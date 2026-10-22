import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import {
  createBrowserConfigurationPersistence,
  createBrowserConfigurations,
} from '../src/features/plugin-configurations/index.ts';
import type {
  BrowserConfigurationPersistence,
  BrowserConfigurationRecord,
} from '../src/features/plugin-configurations/index.ts';
import type { ConfigurationDefinition } from '../src/plugin-sdk/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import { browserConfigurationServer } from './browser-configuration-fixtures.ts';
import { deferred, failure, signal } from './fixtures.ts';

const baseUrl = 'http://localhost:7031';
const key = 'http://localhost:7031:example';
const definition: ConfigurationDefinition = {
  version: 1,
  apply_policy: 'next_invocation',
  defaults: { count: 2, secret: '默认口令' },
  schema: {
    type: 'object',
    required: ['count'],
    properties: {
      count: { type: 'integer', minimum: 1 },
      secret: { type: 'string', writeOnly: true },
    },
  },
};
const reloadDefinition: ConfigurationDefinition = { ...definition, apply_policy: 'plugin_reload' };
function record(count = 2, applied = true): BrowserConfigurationRecord {
  const revision = crypto.randomUUID();
  return {
    version: 1,
    values: { count, secret: '记录口令' },
    revision,
    applied: applied ? revision : 'defaults',
    sensitivePaths: ['/secret'],
  };
}
function storageFixture() {
  const browser = new JSDOM('', { url: 'http://localhost:5173' });
  return { storage: browser.window.localStorage, close: () => browser.window.close() };
}
const legacyKey = `deviceforge.plugin-configuration:${encodeURIComponent(baseUrl)}:example`;
function configurationModel(persistence: BrowserConfigurationPersistence, legacyStorage?: Storage) {
  const model = createBrowserConfigurations({ baseUrl, persistence, legacyStorage });
  model.define('example', definition);
  return model;
}

test('服务端缺少记录时首次迁移旧浏览器配置，保留旧字节并补记敏感路径', async () => {
  const fixture = storageFixture();
  const server = browserConfigurationServer();
  const legacy = record(7, false);
  const text = JSON.stringify({
    version: legacy.version,
    values: legacy.values,
    revision: legacy.revision,
    applied: legacy.applied,
  });
  fixture.storage.setItem(legacyKey, text);
  const model = server.model(baseUrl + '/', fixture.storage);
  model.define('example', reloadDefinition);
  try {
    const view = await model.get('example', signal());
    assert.equal(view.revision, legacy.revision);
    assert.equal(view.pendingReload, true);
    assert.doesNotMatch(JSON.stringify(view), /记录口令/);
    assert.deepEqual(server.records.get(key), legacy);
    assert.deepEqual(
      server.calls.map(({ method, expected }) => ({ method, expected })),
      [
        { method: 'GET', expected: undefined },
        { method: 'PATCH', expected: null },
      ],
    );
    assert.equal(fixture.storage.getItem(legacyKey), text);
    assert.deepEqual(
      (await model.prepare('example', reloadDefinition, signal()))?.get(),
      legacy.values,
    );
    assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 1);
  } finally {
    model.dispose();
    fixture.close();
  }
});

test('服务端记录始终优先，损坏的旧浏览器数据不会覆盖或阻断远端记录', async () => {
  const fixture = storageFixture();
  const server = browserConfigurationServer();
  const remote = record(8);
  server.records.set(key, remote);
  fixture.storage.setItem(legacyKey, '{损坏的旧记录');
  const model = server.model(baseUrl, fixture.storage);
  model.define('example', definition);
  try {
    assert.equal((await model.get('example', signal())).revision, remote.revision);
    assert.deepEqual((await model.prepare('example', definition, signal()))?.get(), remote.values);
    assert.deepEqual(server.records.get(key), remote);
    assert.equal(
      server.calls.some((call) => call.method === 'PATCH'),
      false,
    );
    assert.equal(fixture.storage.getItem(legacyKey), '{损坏的旧记录');
  } finally {
    model.dispose();
    fixture.close();
  }
});

test('首次迁移发生 CAS 冲突后只重读胜方记录，不重放迁移或删除旧数据', async () => {
  const fixture = storageFixture();
  const server = browserConfigurationServer();
  const legacy = record(3);
  const winner = record(9);
  const text = JSON.stringify(legacy);
  fixture.storage.setItem(legacyKey, text);
  let patches = 0;
  const persistence = createBrowserConfigurationPersistence(
    createApiClient({
      baseUrl,
      transport: async (input, init) => {
        if (init?.method === 'PATCH') {
          ++patches;
          server.records.set(key, winner);
        }
        return server.transport(input, init);
      },
    }),
  );
  const model = configurationModel(persistence, fixture.storage);
  try {
    assert.equal((await model.get('example', signal())).revision, winner.revision);
    assert.equal(patches, 1);
    assert.deepEqual(server.records.get(key), winner);
    assert.equal(fixture.storage.getItem(legacyKey), text);
    assert.deepEqual(
      server.calls.map((call) => call.method),
      ['GET', 'PATCH', 'GET'],
    );
  } finally {
    model.dispose();
    fixture.close();
  }
});

test('旧配置损坏时给出安全错误，不向服务器写入损坏内容', async () => {
  const fixture = storageFixture();
  const server = browserConfigurationServer();
  const text = '{"secret":"不得出现在错误中的口令",';
  fixture.storage.setItem(legacyKey, text);
  const model = server.model(baseUrl, fixture.storage);
  model.define('example', definition);
  try {
    await assert.rejects(model.get('example', signal()), {
      message: '浏览器插件旧配置记录损坏，未迁移到服务器',
    });
    assert.equal(server.records.size, 0);
    assert.equal(
      server.calls.some((call) => call.method === 'PATCH'),
      false,
    );
    assert.equal(fixture.storage.getItem(legacyKey), text);
  } finally {
    model.dispose();
    fixture.close();
  }
});

test('读取及保存失败保留公开错误和日志 ID，不降级本地存储或更新运行值', async () => {
  const fixture = storageFixture();
  const server = browserConfigurationServer();
  const stored = record();
  server.records.set(key, stored);
  let fail: 'GET' | 'PATCH' | null = null;
  const persistence = createBrowserConfigurationPersistence(
    createApiClient({
      baseUrl,
      transport: async (input, init) =>
        (init?.method ?? 'GET') === fail
          ? failure('configuration_unavailable', 503)
          : server.transport(input, init),
    }),
  );
  const model = configurationModel(persistence, fixture.storage);
  const events: unknown[] = [];
  try {
    const access = await model.prepare('example', definition, signal());
    assert.ok(access);
    const release = access.subscribe((value) => {
      events.push(value);
    });
    fail = 'GET';
    await assert.rejects(model.get('example', signal()), {
      kind: 'http',
      status: 503,
      code: 'configuration_unavailable',
      logId: 'log-error',
    });
    fail = 'PATCH';
    await assert.rejects(
      model.save('example', stored.revision, { count: 6, secret: '新口令' }, signal()),
      { kind: 'http', status: 503, code: 'configuration_unavailable', logId: 'log-error' },
    );
    assert.deepEqual(access.get(), stored.values);
    assert.deepEqual(events, []);
    assert.deepEqual(server.records.get(key), stored);
    assert.equal(fixture.storage.length, 0);
    release();
  } finally {
    model.dispose();
    fixture.close();
  }
});

test('GET 后其他窗口完成写入时依赖服务器 CAS 拒绝覆盖，不提前发布运行值', async () => {
  const server = browserConfigurationServer();
  const stored = record();
  const winner = record(8);
  server.records.set(key, stored);
  let race = false;
  const persistence = createBrowserConfigurationPersistence(
    createApiClient({
      baseUrl,
      transport: async (input, init) => {
        if (race && init?.method === 'PATCH') server.records.set(key, winner);
        return server.transport(input, init);
      },
    }),
  );
  const model = configurationModel(persistence);
  const events: unknown[] = [];
  try {
    const access = await model.prepare('example', definition, signal());
    assert.ok(access);
    const release = access.subscribe((value) => {
      events.push(value);
    });
    race = true;
    await assert.rejects(model.save('example', stored.revision, { count: 6 }, signal()), {
      status: 409,
      code: 'configuration_conflict',
      logId: 'log-error',
    });
    assert.deepEqual(server.records.get(key), winner);
    assert.deepEqual(access.get(), stored.values);
    assert.deepEqual(events, []);
    assert.equal((await model.get('example', signal())).revision, winner.revision);
    release();
  } finally {
    model.dispose();
  }
});

test('首次默认值也持久化，包升级的默认值不能覆盖已经使用的配置', async () => {
  const server = browserConfigurationServer();
  const model = server.model(baseUrl);
  model.define('example', definition);
  try {
    const first = await model.get('example', signal());
    assert.equal(first.revision, 'defaults');
    assert.deepEqual(server.records.get(key), {
      version: 1,
      values: definition.defaults,
      revision: 'defaults',
      applied: 'defaults',
      sensitivePaths: ['/secret'],
    });
    assert.deepEqual(
      server.calls.map(({ method, expected }) => ({ method, expected })),
      [
        { method: 'GET', expected: undefined },
        { method: 'PATCH', expected: null },
      ],
    );
    const upgraded = { ...definition, defaults: { count: 99, secret: '新包默认口令' } };
    model.define('example', upgraded);
    assert.deepEqual(
      (await model.prepare('example', upgraded, signal()))?.get(),
      definition.defaults,
    );
    assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 1);
  } finally {
    model.dispose();
  }
});

test('首次默认值创建发生冲突时只采用服务端胜方配置', async () => {
  const server = browserConfigurationServer();
  const winner = record(11);
  const persistence = createBrowserConfigurationPersistence(
    createApiClient({
      baseUrl,
      transport: async (input, init) => {
        if (init?.method === 'PATCH') server.records.set(key, winner);
        return server.transport(input, init);
      },
    }),
  );
  const model = configurationModel(persistence);
  try {
    assert.deepEqual((await model.prepare('example', definition, signal()))?.get(), winner.values);
    assert.deepEqual(
      server.calls.map((call) => call.method),
      ['GET', 'PATCH', 'GET'],
    );
  } finally {
    model.dispose();
  }
});

test('无配置声明的插件读取、准备和确认应用均不访问配置 API', async () => {
  const server = browserConfigurationServer();
  const model = server.model(baseUrl);
  model.define('offline', null);
  try {
    assert.equal((await model.get('offline', signal())).definition, null);
    assert.equal(await model.prepare('offline', null, signal()), undefined);
    await model.markApplied('offline', signal());
    assert.deepEqual(server.calls, []);
  } finally {
    model.dispose();
  }
});

test('取消旧 prepare 后新请求不被忽略信号的 GET 阻塞，晚到结果不得覆盖新运行值', async () => {
  const gate = deferred<BrowserConfigurationRecord>();
  const started = deferred<void>();
  const stored = record(4);
  let reads = 0;
  const model = configurationModel({
    get: async () => {
      if (++reads === 1) {
        started.resolve();
        return gate.promise;
      }
      return stored;
    },
    save: async () => {
      throw new Error('测试不应写入');
    },
  });
  const cancellation = new AbortController();
  try {
    const pending = model.prepare('example', definition, cancellation.signal);
    const rejected = assert.rejects(pending, { kind: 'cancelled' });
    await started.promise;
    cancellation.abort();
    await rejected;
    const access = await model.prepare('example', definition, signal());
    assert.ok(access);
    gate.resolve(record(10));
    await nextTurn();
    assert.deepEqual(access.get(), stored.values);
    assert.equal(reads, 2);
  } finally {
    gate.resolve(stored);
    model.dispose();
  }
});

test('取消保存后旧 PATCH 不阻塞新保存，晚到记录不触发订阅或覆盖新值', async () => {
  const gate = deferred<BrowserConfigurationRecord>();
  const started = deferred<void>();
  const original = record();
  let stored = original;
  let writes = 0;
  const model = configurationModel({
    get: async () => stored,
    save: async (_id, _revision, next) => {
      if (++writes === 1) {
        started.resolve();
        return gate.promise;
      }
      stored = next;
      return next;
    },
  });
  const cancellation = new AbortController();
  const events: unknown[] = [];
  try {
    const access = await model.prepare('example', definition, signal());
    assert.ok(access);
    const release = access.subscribe((value) => {
      events.push(value);
    });
    const pending = model.save('example', original.revision, { count: 7 }, cancellation.signal);
    const rejected = assert.rejects(pending, { kind: 'cancelled' });
    await started.promise;
    cancellation.abort();
    await rejected;
    await model.save('example', original.revision, { count: 5 }, signal());
    gate.resolve(record(7));
    await nextTurn();
    assert.deepEqual(access.get(), { count: 5 });
    assert.deepEqual(events, [{ count: 5 }]);
    assert.equal(writes, 2);
    release();
  } finally {
    gate.resolve(original);
    model.dispose();
  }
});

test('运行实例销毁后忽略信号的 PATCH 晚到不会恢复运行值或通知订阅者', async () => {
  const gate = deferred<BrowserConfigurationRecord>();
  const started = deferred<void>();
  const stored = record();
  const model = configurationModel({
    get: async () => stored,
    save: async () => {
      started.resolve();
      return gate.promise;
    },
  });
  const events: unknown[] = [];
  try {
    const access = await model.prepare('example', definition, signal());
    assert.ok(access);
    access.subscribe((value) => {
      events.push(value);
    });
    const rejected = assert.rejects(
      model.save('example', stored.revision, { count: 6 }, signal()),
      { kind: 'cancelled' },
    );
    await started.promise;
    model.dispose();
    await rejected;
    gate.resolve(record(6));
    await nextTurn();
    assert.deepEqual(access.get(), stored.values);
    assert.deepEqual(events, []);
    await assert.rejects(model.get('example', signal()), { kind: 'cancelled' });
  } finally {
    gate.resolve(stored);
    model.dispose();
  }
});

test('插件激活期间记录变更时不能把其他窗口的新修订标成已应用', async () => {
  const server = browserConfigurationServer();
  const prepared = record(3, false);
  const winner = record(7, false);
  server.records.set(key, prepared);
  const model = server.model(baseUrl);
  model.define('example', reloadDefinition);
  try {
    const access = await model.prepare('example', reloadDefinition, signal());
    assert.ok(access);
    server.records.set(key, winner);
    await assert.rejects(model.markApplied('example', signal()), /其他窗口修改/);
    assert.deepEqual(server.records.get(key), winner);
    assert.deepEqual(access.get(), prepared.values);
    assert.equal(
      server.calls.some((call) => call.method === 'PATCH'),
      false,
    );
  } finally {
    model.dispose();
  }
});

test('确认应用的 GET 与 PATCH 之间发生竞争时由服务端 CAS 拒绝覆盖', async () => {
  const server = browserConfigurationServer();
  const prepared = record(3, false);
  const winner = record(7, false);
  server.records.set(key, prepared);
  const persistence = createBrowserConfigurationPersistence(
    createApiClient({
      baseUrl,
      transport: async (input, init) => {
        if (init?.method === 'PATCH') server.records.set(key, winner);
        return server.transport(input, init);
      },
    }),
  );
  const model = configurationModel(persistence);
  try {
    await model.prepare('example', reloadDefinition, signal());
    await assert.rejects(model.markApplied('example', signal()), {
      status: 409,
      code: 'configuration_conflict',
      logId: 'log-error',
    });
    assert.deepEqual(server.records.get(key), winner);
    assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 1);
  } finally {
    model.dispose();
  }
});

test('应用操作固定目标修订，重载期间其他窗口写入时拒绝准备新配置', async () => {
  const server = browserConfigurationServer();
  const stored = record(3, false);
  const winner = record(7, false);
  server.records.set(key, stored);
  const model = server.model(baseUrl);
  model.define('example', reloadDefinition);
  try {
    const access = await model.prepare('example', reloadDefinition, signal());
    assert.ok(access);
    await assert.rejects(
      model.apply('example', stored.revision, signal(), async (active) => {
        server.records.set(key, winner);
        await model.prepare('example', reloadDefinition, active);
      }),
      /其他窗口修改/,
    );
    assert.deepEqual(access.get(), stored.values);
    assert.deepEqual(server.records.get(key), winner);
    // 失败后必须释放应用占用，用户刷新后可以明确应用新修订。
    await model.apply('example', winner.revision, signal(), async (active) => {
      await model.prepare('example', reloadDefinition, active);
      await model.markApplied('example', active);
    });
    assert.equal(server.records.get(key)?.applied, winner.revision);
  } finally {
    model.dispose();
  }
});

test('迁移 PATCH 失败保留旧配置字节，且不能本地保存后伪报成功', async () => {
  const fixture = storageFixture();
  const stored = record(3);
  const text = JSON.stringify(stored);
  fixture.storage.setItem(legacyKey, text);
  let writes = 0;
  const model = configurationModel(
    {
      get: async () => null,
      save: async () => {
        ++writes;
        throw new ApiError('http', 'configuration_unavailable', '暂不可用', 503, 'migration-log');
      },
    },
    fixture.storage,
  );
  try {
    await assert.rejects(model.prepare('example', definition, signal()), {
      status: 503,
      code: 'configuration_unavailable',
      logId: 'migration-log',
    });
    assert.equal(writes, 1);
    assert.equal(fixture.storage.getItem(legacyKey), text);
  } finally {
    model.dispose();
    fixture.close();
  }
});

test('远端 GET 失败时不读取旧数据或创建默认记录', async () => {
  const fixture = storageFixture();
  fixture.storage.setItem(legacyKey, '{损坏的旧配置');
  let writes = 0;
  const model = configurationModel(
    {
      get: async () => {
        throw new ApiError('http', 'configuration_unavailable', '暂不可用', 503, 'read-log');
      },
      save: async () => {
        ++writes;
        return record();
      },
    },
    fixture.storage,
  );
  try {
    await assert.rejects(model.prepare('example', definition, signal()), {
      status: 503,
      logId: 'read-log',
    });
    assert.equal(writes, 0);
    assert.equal(fixture.storage.getItem(legacyKey), '{损坏的旧配置');
  } finally {
    model.dispose();
    fixture.close();
  }
});
