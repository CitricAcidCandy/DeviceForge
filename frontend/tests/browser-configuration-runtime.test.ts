import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ConfigurationAccess, HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import { createPluginManager } from '../src/plugins/index.ts';
import { browserConfigurationServer } from './browser-configuration-fixtures.ts';
import { deferred } from './fixtures.ts';

function host(): HostContext {
  return {
    apiVersion: 2,
    signal: new AbortController().signal,
    listOperations: async () => ({ data: [], logId: 'list-log' }),
    submit: async () => ({
      data: { id: 'job', operation: 'example.run', status: 'queued', result: null, error: null },
      logId: 'submit-log',
    }),
    getJob: async () => ({
      data: { id: 'job', operation: 'example.run', status: 'queued', result: null, error: null },
      logId: 'job-log',
    }),
    cancelJob: async () => ({
      data: { id: 'job', operation: 'example.run', status: 'cancelled', result: null, error: null },
      logId: 'cancel-log',
    }),
    subscribeOperations: () => () => {},
    onDispose: () => () => {},
  };
}
function plugin(overrides: Partial<WebPlugin> = {}): WebPlugin {
  return {
    id: 'example',
    version: '1.0.0',
    apiVersion: 2,
    panels: [],
    configuration: {
      version: 1,
      apply_policy: 'plugin_reload',
      defaults: { count: 2 },
      schema: { type: 'object', properties: { count: { type: 'integer' } } },
    },
    ...overrides,
  };
}
const access: ConfigurationAccess = { get: () => ({ count: 2 }), subscribe: () => () => {} };

test('配置异步准备完成前不激活，应用确认完成前不发布已加载状态', async () => {
  const prepared = deferred<ConfigurationAccess>();
  const prepareStarted = deferred<void>();
  const applied = deferred<void>();
  const applyStarted = deferred<void>();
  const events: string[] = [];
  const manager = createPluginManager({
    host: host(),
    panelTarget: () => null,
    configuration: () => {
      prepareStarted.resolve();
      return prepared.promise;
    },
    configurationApplied: () => {
      applyStarted.resolve();
      return applied.promise;
    },
  });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      async activate(context) {
        events.push('激活');
        assert.deepEqual(context.configuration?.get(), { count: 2 });
      },
    }),
  });
  try {
    const loading = manager.load('example');
    await prepareStarted.promise;
    assert.deepEqual(events, []);
    assert.equal(manager.snapshot()[0]?.state, 'loading');
    prepared.resolve(access);
    await applyStarted.promise;
    assert.deepEqual(events, ['激活']);
    assert.equal(manager.snapshot()[0]?.state, 'loading');
    applied.resolve();
    assert.equal((await loading).state, 'loaded');
  } finally {
    prepared.resolve(access);
    applied.resolve();
    await manager.dispose();
  }
});

test('prepare 忽略信号时卸载仍结束等待，晚到结果不能激活旧代插件', async () => {
  const prepared = deferred<ConfigurationAccess>();
  const started = deferred<void>();
  let activated = 0;
  let deactivated = 0;
  const manager = createPluginManager({
    host: host(),
    panelTarget: () => null,
    configuration: () => {
      started.resolve();
      return prepared.promise;
    },
  });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      activate: async () => {
        ++activated;
      },
      deactivate: () => {
        ++deactivated;
      },
    }),
  });
  try {
    const rejected = assert.rejects(manager.load('example'), { kind: 'cancelled' });
    await started.promise;
    await manager.unload('example');
    await rejected;
    assert.deepEqual(manager.snapshot(), []);
    prepared.resolve(access);
    await nextTurn();
    assert.equal(activated, 0);
    assert.equal(deactivated, 0);
  } finally {
    prepared.resolve(access);
    await manager.dispose();
  }
});

test('确认应用忽略信号时卸载仍取消等待并清理激活资源，晚到拒绝被消费', async () => {
  const applied = deferred<void>();
  const started = deferred<void>();
  const events: string[] = [];
  const manager = createPluginManager({
    host: host(),
    panelTarget: () => null,
    configuration: () => ({
      get: access.get,
      subscribe: () => () => {
        events.push('撤销订阅');
      },
    }),
    configurationApplied: () => {
      started.resolve();
      return applied.promise;
    },
  });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      async activate(context) {
        context.configuration?.subscribe(() => {});
        context.onDispose(() => {
          events.push('释放资源');
        });
      },
      deactivate: () => {
        events.push('停用');
      },
    }),
  });
  try {
    const rejected = assert.rejects(manager.load('example'), { kind: 'cancelled' });
    await started.promise;
    await manager.unload('example');
    await rejected;
    assert.deepEqual(events, ['释放资源', '撤销订阅', '停用']);
    assert.deepEqual(manager.snapshot(), []);
    applied.reject(new Error('晚到确认失败'));
    await nextTurn();
    assert.deepEqual(manager.snapshot(), []);
  } finally {
    applied.resolve();
    await manager.dispose();
  }
});

test('应用确认失败回滚已激活资源，保留原错误且不发布 loaded', async () => {
  const events: string[] = [];
  const failure = new Error('配置确认失败');
  const manager = createPluginManager({
    host: host(),
    panelTarget: () => null,
    configuration: async () => access,
    configurationApplied: async () => {
      throw failure;
    },
  });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      async activate(context) {
        events.push('激活');
        context.onDispose(() => {
          events.push('释放资源');
        });
      },
      deactivate: () => {
        events.push('停用');
      },
    }),
  });
  try {
    await assert.rejects(manager.load('example'), (reason: unknown) => reason === failure);
    assert.deepEqual(events, ['激活', '释放资源', '停用']);
    assert.deepEqual(manager.snapshot(), []);
  } finally {
    await manager.dispose();
  }
});

test('真实配置模型确认应用遇到 CAS 冲突时宿主回滚，不确认其他窗口配置', async () => {
  const server = browserConfigurationServer();
  const model = server.model('http://localhost:7031');
  const revision = crypto.randomUUID();
  const winnerRevision = crypto.randomUUID();
  const key = 'http://localhost:7031:example';
  server.records.set(key, {
    version: 1,
    values: { count: 2 },
    revision,
    applied: 'defaults',
    sensitivePaths: [],
  });
  const events: string[] = [];
  const manager = createPluginManager({
    host: host(),
    panelTarget: () => null,
    configuration: (source, signal) =>
      model.prepare(source.id, source.configuration ?? null, signal),
    configurationApplied: (source, signal) => model.markApplied(source.id, signal),
  });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      async activate(context) {
        assert.deepEqual(context.configuration?.get(), { count: 2 });
        context.onDispose(() => {
          events.push('释放资源');
        });
        server.records.set(key, {
          version: 1,
          values: { count: 9 },
          revision: winnerRevision,
          applied: 'defaults',
          sensitivePaths: [],
        });
      },
      deactivate: () => {
        events.push('停用');
      },
    }),
  });
  try {
    await assert.rejects(manager.load('example'), /其他窗口修改/);
    assert.deepEqual(events, ['释放资源', '停用']);
    assert.deepEqual(manager.snapshot(), []);
    assert.equal(server.records.get(key)?.revision, winnerRevision);
    assert.equal(server.records.get(key)?.applied, 'defaults');
    assert.equal(
      server.calls.some((call) => call.method === 'PATCH'),
      false,
    );
  } finally {
    await manager.dispose();
    model.dispose();
  }
});
