import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginManager, readPluginModule } from '../src/plugins/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type {
  HostContext,
  HostResult,
  Job,
  Operation,
  WebPlugin,
} from '../src/plugin-sdk/index.ts';
import { deferred } from './fixtures.ts';
import { children, dom } from './dom-fixtures.ts';

function host(overrides: Partial<HostContext> = {}) {
  const lifetime = new AbortController();
  const listeners = new Set<(operations: readonly Operation[]) => void>();
  const context: HostContext = {
    apiVersion: 2,
    signal: lifetime.signal,
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
    subscribeOperations: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onDispose: () => () => {},
    ...overrides,
  };
  return { context, lifetime, listeners };
}
function plugin(overrides: Partial<WebPlugin> = {}): WebPlugin {
  return {
    id: 'example',
    version: '1.0.0',
    apiVersion: 2,
    panels: [{ id: 'example.main', title: '主面板', mount: async () => () => {} }],
    ...overrides,
  };
}

test('可信登记、SDK 版本及 loader 返回值在运行时被校验', async () => {
  const manager = createPluginManager({ host: host().context, panelTarget: () => null });
  // 反射调用模拟不受 TypeScript 约束的外部 JavaScript，验证可信登记的运行时边界。
  assert.throws(
    () =>
      Reflect.apply(manager.register, manager, [
        { id: 'example', trusted: false, plugin: plugin() },
      ]),
    /可信/,
  );
  assert.throws(() => readPluginModule({ ...plugin(), apiVersion: 1 }), /SDK v2/);
  assert.throws(
    () => readPluginModule({ ...plugin(), panels: [{ id: 'example.main', title: '面板' }] }),
    /SDK v2/,
  );
  await assert.rejects(manager.load('unknown'), /预注册/);
  manager.register({
    id: 'example',
    trusted: true,
    loader: async () => ({ default: plugin({ id: 'other', panels: [] }) }),
  });
  await assert.rejects(manager.load('example'), /标识/);
  assert.deepEqual(manager.snapshot(), []);
  await manager.dispose();
});

test('重复装载/挂载串行合并，卸载逆序清理订阅/DOM/资源，不删除宿主节点', async () => {
  const environment = host();
  const target = dom();
  const existing = target.ownerDocument.createElement('div');
  target.append(existing);
  const order: string[] = [];
  let activations = 0;
  let mounts = 0;
  let notifications = 0;
  const manager = createPluginManager({ host: environment.context, panelTarget: () => target });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      activate: async (context) => {
        ++activations;
        context.onDispose(() => {
          order.push('资源一');
        });
        context.onDispose(() => {
          order.push('资源二');
        });
        context.subscribeOperations(() => {
          ++notifications;
        });
      },
      panels: [
        {
          id: 'example.main',
          title: '主面板',
          mount: async () => {
            ++mounts;
            return () => {
              order.push('面板');
            };
          },
        },
      ],
      deactivate: async () => {
        order.push('停用');
      },
    }),
  });
  const [first, second] = await Promise.all([manager.load('example'), manager.load('example')]);
  assert.equal(first.generation, second.generation);
  assert.equal(activations, 1);
  await Promise.all([
    manager.mount('example', 'example.main'),
    manager.mount('example', 'example.main'),
  ]);
  assert.equal(mounts, 1);
  assert.equal(target.children.length, 2);
  assert.equal(environment.listeners.size, 1);
  const lateListener = [...environment.listeners][0];
  assert.ok(lateListener);
  await Promise.all([manager.unload('example'), manager.unload('example')]);
  assert.deepEqual(order, ['面板', '资源二', '资源一', '停用']);
  assert.deepEqual(children(target), [existing]);
  assert.equal(environment.listeners.size, 0);
  lateListener([]);
  assert.equal(notifications, 0);
  assert.deepEqual(manager.snapshot(), []);
  await manager.dispose();
});

test('面板挂载失败回滚整代，已挂载面板与部分失败资源均释放', async () => {
  const target = dom();
  const environment = host();
  let releaseCount = 0;
  let deactivations = 0;
  const manager = createPluginManager({ host: environment.context, panelTarget: () => target });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      panels: [
        {
          id: 'example.one',
          title: '一',
          mount: async () => () => {
            ++releaseCount;
          },
        },
        {
          id: 'example.two',
          title: '二',
          mount: async (_root, context) => {
            context.subscribeOperations(() => {});
            context.onDispose(() => {
              ++releaseCount;
            });
            throw new Error('挂载失败');
          },
        },
      ],
      deactivate: async () => {
        ++deactivations;
      },
    }),
  });
  await manager.load('example');
  await manager.mount('example', 'example.one');
  await assert.rejects(manager.mount('example', 'example.two'), /挂载失败/);
  assert.equal(releaseCount, 2);
  assert.equal(deactivations, 1);
  assert.equal(environment.listeners.size, 0);
  assert.equal(target.children.length, 0);
  assert.deepEqual(manager.snapshot(), []);
  await manager.dispose();
});

test('激活失败及释放失败汇总，其他资源和另一个插件仍正常收敛', async () => {
  const manager = createPluginManager({ host: host().context, panelTarget: () => null });
  let released = 0;
  let attempts = 0;
  manager.register({ id: 'healthy', trusted: true, plugin: plugin({ id: 'healthy', panels: [] }) });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      activate: async (context) => {
        context.onDispose(() => {
          ++released;
        });
        if (++attempts === 1) {
          context.onDispose(() => { throw new Error('资源释放失败'); });
          throw new Error('激活失败');
        }
      },
    }),
  });
  await manager.load('healthy');
  await assert.rejects(
    manager.load('example'),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(released, 1);
  assert.equal(manager.snapshot()[0]?.id, 'healthy');
  const diagnostic = manager.cleanupSnapshot()[0];
  assert.ok(diagnostic);
  assert.equal(diagnostic.id, 'example');
  assert.ok(diagnostic.error instanceof AggregateError);
  const next = await manager.load('example');
  assert.notEqual(next.generation, diagnostic.generation);
  assert.equal(attempts, 2);
  assert.equal(manager.cleanupSnapshot()[0], diagnostic, '新操作不能掩盖历史失败');
  await manager.unload('example');
  await manager.unregister('example');
  await assert.rejects(manager.load('example'), /预注册/);
  assert.equal(released, 2);
  await manager.dispose();
});

test('在途清理仍串行等待，有界超时保留旧代诊断，晚到拒绝不影响新代', async (t) => {
  for (const mode of ['scope', 'deactivate', 'confirmed'] as const) await t.test(mode, async (t) => {
    // 绝对期限和定时器必须使用同一时钟，避免真实耗时提前吃掉边界毫秒。
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const pending = deferred<void>();
    const began = deferred<void>();
    const contexts: HostContext[] = [];
    let activations = 0;
    let deactivations = 0;
    const manager = createPluginManager({ host: host().context, panelTarget: () => null });
    manager.register({ id: 'example', trusted: true, plugin: plugin({
      activate: async (context) => {
        contexts.push(context);
        if (++activations === 1 && mode !== 'deactivate') context.onDispose(() => {
          began.resolve();
          return pending.promise;
        });
      },
      deactivate: async () => {
        if (++deactivations === 1 && mode === 'deactivate') {
          began.resolve();
          return pending.promise;
        }
      },
    }) });
    try {
      const first = await manager.load('example');
      const unloading = manager.unload('example');
      const outcome = mode === 'confirmed' ? unloading : assert.rejects(unloading, (error: unknown) =>
        error instanceof AggregateError && error.errors.some((failure: unknown) =>
          failure instanceof HostError && failure.code === 'plugin_cleanup_timeout'));
      const loading = manager.load('example');
      await began.promise;
      const oldContext = contexts[0];
      assert.ok(oldContext);
      assert.equal(oldContext.signal.aborted, true);
      t.mock.timers.tick(4999);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(activations, 1, '正在清理时不能开始新一代');
      if (mode === 'confirmed') pending.resolve();
      else t.mock.timers.tick(1);
      await outcome;
      const next = await loading;
      assert.notEqual(next.generation, first.generation);
      assert.equal(activations, 2);
      const diagnostic = manager.cleanupSnapshot()[0];
      if (mode === 'confirmed') assert.equal(diagnostic, undefined);
      else {
        assert.equal(diagnostic?.generation, first.generation);
        assert.ok(diagnostic?.error instanceof AggregateError);
        pending.reject(new Error('旧清理晚到失败'));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(manager.snapshot()[0]?.generation, next.generation);
      assert.equal(manager.cleanupSnapshot()[0], diagnostic);
      await assert.rejects(oldContext.listOperations(oldContext.signal), /代际/);
      let lateReleased = 0;
      oldContext.onDispose(() => { lateReleased++; });
      assert.equal(lateReleased, 1, '旧代晚登记资源立即释放，不能注册到新代');
      await manager.unregister('example');
      assert.deepEqual(manager.snapshot(), []);
    } finally {
      pending.resolve();
      await manager.dispose();
    }
  });
});

test('撤销源的本次清理失败仍抛错，用户再次撤销不被历史诊断封锁', async () => {
  const manager = createPluginManager({ host: host().context, panelTarget: () => null });
  manager.register({ id: 'example', trusted: true, plugin: plugin({ activate: async (context) => {
    context.onDispose(() => { throw new Error('原始释放失败'); });
  } }) });
  try {
    await manager.load('example');
    await assert.rejects(manager.unregister('example'), AggregateError);
    const diagnostic = manager.cleanupSnapshot()[0];
    assert.ok(diagnostic?.error instanceof AggregateError);
    await manager.unregister('example');
    await assert.rejects(manager.load('example'), /预注册/);
    assert.equal(manager.cleanupSnapshot()[0], diagnostic);
  } finally { await manager.dispose(); }
});

test('loader 晚到模块不激活，卸载撤销当前代，重载获得新代际', async () => {
  const loaded = deferred<{ default: WebPlugin }>();
  const began = deferred<AbortSignal>();
  let activations = 0;
  let loads = 0;
  const manager = createPluginManager({ host: host().context, panelTarget: () => null });
  const module = plugin({
    panels: [],
    activate: async () => {
      ++activations;
    },
  });
  manager.register({
    id: 'example',
    trusted: true,
    loader: async (signal) => {
      ++loads;
      if (loads > 1) return { default: module };
      began.resolve(signal);
      return loaded.promise;
    },
  });
  const pending = manager.load('example');
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  const lifetime = await began.promise;
  const oldGeneration = manager.snapshot()[0]?.generation;
  assert.ok(oldGeneration !== undefined);
  const removed = manager.unload('example');
  assert.equal(lifetime.aborted, true);
  loaded.resolve({ default: module });
  await rejected;
  await removed;
  assert.equal(activations, 0);
  const newGeneration = (await manager.load('example')).generation;
  assert.ok(newGeneration > oldGeneration);
  assert.equal(activations, 1);
  await manager.dispose();
});

test('激活中的卸载立即撤销生命周期，等待激活收敛再停用，晚登记资源立即释放', async () => {
  const done = deferred<void>();
  const began = deferred<HostContext>();
  const events: string[] = [];
  const manager = createPluginManager({ host: host().context, panelTarget: () => null });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      activate: async (context) => {
        context.onDispose(() => {
          events.push('早期资源');
        });
        began.resolve(context);
        await done.promise;
        context.onDispose(() => {
          events.push('晚到资源');
        });
        events.push('激活返回');
      },
      deactivate: async () => {
        events.push('停用');
      },
    }),
  });
  const loading = manager.load('example');
  const rejected = assert.rejects(
    loading,
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  const context = await began.promise;
  const unloading = manager.unload('example');
  assert.equal(context.signal.aborted, true);
  assert.deepEqual(events, ['早期资源']);
  done.resolve();
  await rejected;
  await unloading;
  assert.deepEqual(events, ['早期资源', '晚到资源', '激活返回', '停用']);
  await manager.dispose();
});

test('卸载中的晚到面板释放函数仅执行一次，DOM 在卸载请求时移除', async () => {
  const mounted = deferred<void>();
  const began = deferred<HostContext>();
  let releases = 0;
  const target = dom();
  const manager = createPluginManager({ host: host().context, panelTarget: () => target });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      panels: [
        {
          id: 'example.main',
          title: '面板',
          mount: async (_root, context) => {
            began.resolve(context);
            await mounted.promise;
            return () => {
              ++releases;
            };
          },
        },
      ],
    }),
  });
  await manager.load('example');
  const pending = manager.mount('example', 'example.main');
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  const context = await began.promise;
  const unloading = manager.unload('example');
  assert.equal(context.signal.aborted, true);
  assert.equal(target.children.length, 0);
  mounted.resolve();
  await rejected;
  await unloading;
  assert.equal(releases, 1);
  await manager.dispose();
});

test('面板子生命周期独立，卸载取消请求，旧代结果不进入新代', async () => {
  const response = deferred<HostResult<Job>>();
  let requestSignal: AbortSignal | undefined;
  let pluginContext: HostContext | undefined;
  let panelContext: HostContext | undefined;
  const target = dom();
  const environment = host({
    getJob: async (_id, signal) => {
      requestSignal = signal;
      return response.promise;
    },
  });
  const manager = createPluginManager({ host: environment.context, panelTarget: () => target });
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      activate: async (context) => {
        pluginContext = context;
      },
      panels: [
        {
          id: 'example.main',
          title: '面板',
          mount: async (_root, context) => {
            panelContext = context;
            return () => {};
          },
        },
      ],
    }),
  });
  await manager.load('example');
  await manager.mount('example', 'example.main');
  assert.ok(panelContext && pluginContext);
  const request = panelContext.getJob('job', panelContext.signal);
  const rejected = assert.rejects(
    request,
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  await manager.unmount('example', 'example.main');
  assert.ok(requestSignal);
  assert.equal(requestSignal.aborted, true);
  assert.equal(pluginContext.signal.aborted, false);
  response.resolve({
    data: { id: 'job', operation: 'example.run', status: 'queued', result: null, error: null },
    logId: 'late-log',
  });
  await rejected;
  const oldContext = pluginContext;
  await manager.unload('example');
  await manager.load('example');
  assert.notEqual(pluginContext, oldContext);
  await assert.rejects(oldContext.listOperations(oldContext.signal), /代际/);
  await manager.dispose();
});

test('关闭拒绝排队中的新加载，不重复执行停用', async () => {
  const manager = createPluginManager({ host: host().context, panelTarget: () => null });
  let deactivations = 0;
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      panels: [],
      deactivate: async () => {
        ++deactivations;
      },
    }),
  });
  await manager.load('example');
  await Promise.all([manager.dispose(), manager.dispose()]);
  assert.equal(deactivations, 1);
  await assert.rejects(manager.load('example'), /撤销/);
  assert.throws(() => manager.register({ id: 'other', trusted: true, plugin: plugin() }), /关闭/);
});

test('撤销包源先清理运行代次，更新后可重新登记，同ID旧loader不复用', async () => {
  const manager = createPluginManager({ host: host().context, panelTarget: () => null });
  let activations = 0;
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      panels: [],
      activate: async () => {
        ++activations;
      },
    }),
  });
  const first = await manager.load('example');
  await manager.unregister('example');
  await assert.rejects(manager.load('example'), /预注册/);
  manager.register({
    id: 'example',
    trusted: true,
    loader: async () => ({
      default: plugin({
        panels: [],
        version: '2.0',
        activate: async () => {
          activations += 2;
        },
      }),
    }),
  });
  const second = await manager.load('example');
  assert.ok(second.generation > first.generation);
  assert.equal(activations, 3);
  await manager.dispose();
});

test('同轮排队挂载后撤销不进入插件，进行中面板撤销只结束面板子生命周期', async () => {
  const manager = createPluginManager({ host: host().context, panelTarget: () => dom() });
  const began = deferred<HostContext>();
  const done = deferred<void>();
  let mounts = 0;
  let releases = 0;
  manager.register({
    id: 'example',
    trusted: true,
    plugin: plugin({
      panels: [
        {
          id: 'example.main',
          title: '面板',
          mount: async (_root, context) => {
            ++mounts;
            began.resolve(context);
            await done.promise;
            return () => {
              ++releases;
            };
          },
        },
      ],
    }),
  });
  await manager.load('example');
  const queued = manager.mount('example', 'example.main');
  const queuedFailure = assert.rejects(queued, /排队面板/);
  await manager.unmount('example', 'example.main');
  await queuedFailure;
  assert.equal(mounts, 0);
  const pending = manager.mount('example', 'example.main');
  const pendingFailure = assert.rejects(
    pending,
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  const context = await began.promise;
  const removed = manager.unmount('example', 'example.main');
  assert.equal(context.signal.aborted, true);
  done.resolve();
  await pendingFailure;
  await removed;
  assert.equal(releases, 1);
  assert.equal(manager.snapshot()[0]?.state, 'loaded');
  await manager.dispose();
});
