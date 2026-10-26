import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import type { RuntimeOptions } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type {
  BeforeTaskSubmitHook,
  ComponentContribution,
  Dispose,
  ExtensionAccess,
  HostContext,
  HostResult,
  JsonValue,
  ModuleContribution,
  PluginContributions,
  TaskSubmission,
  WebPlugin,
} from '../src/plugin-sdk/index.ts';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import { createTaskLab } from '../src/plugins/examples/task-lab.ts';
import { deferred, job, requestUrl, signal, success } from './fixtures.ts';
import { children, dom } from './dom-fixtures.ts';
import { browserConfigurationServer } from './browser-configuration-fixtures.ts';

function runtime(overrides: Partial<RuntimeOptions> = {}) {
  return createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async () => success(job()),
    ...overrides,
  });
}
function register(
  instance: ReturnType<typeof runtime>,
  id: string,
  contributions: PluginContributions,
  activate?: WebPlugin['activate'],
) {
  instance.webPlugins.register({
    id,
    trusted: true,
    plugin: {
      id,
      version: '1.0',
      apiVersion: 2,
      panels: [],
      contributions,
      ...(activate ? { activate } : {}),
    },
  });
}

function extensionAccess(context: HostContext | undefined): ExtensionAccess {
  assert.ok(context, '插件激活必须提供上下文');
  assert.ok(context.extensions, '测试宿主必须提供扩展入口');
  return context.extensions;
}
function registerContributions(context: HostContext, contributions: PluginContributions): Dispose {
  const access = extensionAccess(context);
  assert.ok(access.register, '插件上下文必须允许登记贡献');
  return access.register(contributions);
}
function submittedBody(init: RequestInit | undefined): unknown {
  assert.ok(init && typeof init.body === 'string', '任务请求必须包含JSON字符串');
  return JSON.parse(init.body);
}
function inputRecord(input: JsonValue): { [key: string]: JsonValue } {
  assert.ok(
    input !== null && typeof input === 'object' && !Array.isArray(input),
    '本测试的任务输入须为对象',
  );
  return input;
}
function contextAt(contexts: readonly HostContext[], index: number): HostContext {
  const context = contexts[index];
  assert.ok(context, '预期挂载上下文必须存在');
  return context;
}

test('实际任务基础用例执行排序输入变换钩子，卸载后恢复原提交逻辑', async () => {
  const submitted: unknown[] = [];
  const order: string[] = [];
  const instance = runtime({
    transport: async (url, init) => {
      assert.equal(requestUrl(url).pathname, '/api/v2/jobs');
      submitted.push(submittedBody(init));
      return success(job(), 'task-log');
    },
  });
  register(instance, 'example', {
    beforeTaskSubmit: [
      {
        id: 'example.later',
        priority: 10,
        transform: async (value) => {
          order.push('后');
          return { ...value, input: { ...inputRecord(value.input), later: true } };
        },
      },
      {
        id: 'example.earlier',
        priority: -1,
        transform: async (value) => {
          order.push('先');
          return {
            ...value,
            operation: 'example.transformed',
            input: { ...inputRecord(value.input), earlier: true },
          };
        },
      },
    ],
  });
  await instance.webPlugins.load('example');
  assert.equal(
    (await instance.host.submit('example.run', { original: 1 }, signal())).logId,
    'task-log',
  );
  assert.deepEqual(order, ['先', '后']);
  assert.deepEqual(submitted[0], {
    operation: 'example.transformed',
    input: { original: 1, earlier: true, later: true },
  });
  await instance.webPlugins.unload('example');
  await instance.tasks.submit({ operation: 'example.run', input: {} }, signal());
  assert.deepEqual(submitted[1], { operation: 'example.run', input: {} });
  await instance.dispose();
});

test('多个插件钩子依 priority 再 id 排序，失败停止后续钩子与 HTTP，卸载恢复', async () => {
  const order: string[] = [];
  const submitted: unknown[] = [];
  const instance = runtime({
    transport: async (_url, init) => {
      submitted.push(submittedBody(init));
      return success(job());
    },
  });
  const hook = (id: string, priority: number, label: string): BeforeTaskSubmitHook => ({
    id,
    priority,
    transform: async (value) => {
      order.push(label);
      return value;
    },
  });
  register(instance, 'zeta', {
    beforeTaskSubmit: [hook('zeta.tie', 0, 'zeta'), hook('zeta.last', 2, 'last')],
  });
  register(instance, 'alpha', {
    beforeTaskSubmit: [hook('alpha.tie', 0, 'alpha'), hook('alpha.first', -1, 'first')],
  });
  await instance.webPlugins.load('zeta');
  await instance.webPlugins.load('alpha');
  const input = { operation: 'example.run', input: { original: true } };
  await instance.tasks.submit(input, signal());
  assert.deepEqual(order, ['first', 'alpha', 'zeta', 'last']);
  register(instance, 'broken', {
    beforeTaskSubmit: [
      {
        id: 'broken.stop',
        priority: 1,
        transform: async () => {
          order.push('failed');
          throw new Error('钩子失败');
        },
      },
    ],
  });
  await instance.webPlugins.load('broken');
  order.length = 0;
  await assert.rejects(instance.tasks.submit(input, signal()), /钩子失败/);
  assert.deepEqual(order, ['first', 'alpha', 'zeta', 'failed']);
  assert.equal(submitted.length, 1);
  await instance.webPlugins.unload('broken');
  order.length = 0;
  await instance.tasks.submit(input, signal());
  assert.deepEqual(order, ['first', 'alpha', 'zeta', 'last']);
  await instance.webPlugins.unload('alpha');
  await instance.webPlugins.unload('zeta');
  order.length = 0;
  await instance.tasks.submit(input, signal());
  assert.deepEqual(order, []);
  assert.deepEqual(submitted[2], input);
  await instance.dispose();
});

test('具名槽位和模块有真实挂载/释放行为，发现入口与命令服务随卸载失效', async () => {
  const slot = dom();
  const moduleRoot = dom();
  let releases = 0;
  const instance = runtime({
    componentTarget: (name) => (name === 'workspace.sidebar' ? slot : null),
    moduleTarget: (route) => (route === '/example' ? moduleRoot : null),
  });
  register(instance, 'example', {
    components: [
      {
        id: 'example.widget',
        title: '组件',
        slot: 'workspace.sidebar',
        mount: async (root) => {
          root.textContent = '动态组件';
          return () => {
            ++releases;
          };
        },
      },
    ],
    modules: [
      {
        id: 'example.page',
        title: '模块',
        route: '/example',
        mount: async (root) => {
          root.textContent = '动态模块';
          return () => {
            ++releases;
          };
        },
      },
    ],
    commands: [
      {
        id: 'example.command',
        title: '命令',
        execute: async (input, host, caller) => {
          const result = await host.submit('example.run', input, caller);
          return { data: result.data.id, logId: result.logId };
        },
      },
    ],
    services: [
      {
        id: 'example.service',
        version: '1',
        invoke: async (input) => ({ data: input, logId: null }),
      },
    ],
  });
  const generation = (await instance.webPlugins.load('example')).generation;
  const catalog = instance.extensions.catalog();
  assert.equal(catalog.modules[0]?.generation, generation);
  assert.equal(catalog.commands[0]?.pluginId, 'example');
  await Promise.all([
    instance.extensions.mountComponent('example.widget'),
    instance.extensions.mountComponent('example.widget'),
  ]);
  await instance.extensions.mountModule('example.page');
  assert.equal(slot.children.length, 1);
  assert.equal(slot.children[0]?.textContent, '动态组件');
  assert.equal(moduleRoot.children[0]?.textContent, '动态模块');
  assert.equal(
    (await instance.extensions.executeCommand('example.command', {}, signal())).logId,
    'log-test',
  );
  assert.deepEqual(
    (await instance.extensions.callService('example.service', '1', [1], signal())).data,
    [1],
  );
  assert.throws(
    () => instance.extensions.callService('example.service', '2', null, signal()),
    /版本/,
  );
  await instance.webPlugins.unload('example');
  assert.equal(releases, 2);
  assert.equal(slot.children.length, 0);
  assert.equal(moduleRoot.children.length, 0);
  assert.deepEqual(instance.extensions.catalog(), {
    components: [],
    modules: [],
    commands: [],
    services: [
      { id: 'host.ai-sdk', pluginId: 'host', generation: 0, version: '1' },
      { id: 'host.ai-sdk.stream', pluginId: 'host', generation: 0, version: '1' },
      { id: 'host.performance', pluginId: 'host', generation: 0, version: '1' },
      { id: 'host.plugin-dependencies', pluginId: 'host', generation: 0, version: '1' },
      { id: 'host.mirroring.stream', pluginId: 'host', generation: 0, version: '1' },
    ],
  });
  assert.throws(
    () => instance.extensions.executeCommand('example.command', null, signal()),
    /撤销/,
  );
  await instance.dispose();
});

test('插件可动态登记命令并撤销，状态限于自身代次，宿主事件订阅随卸载清理', async () => {
  let context: HostContext | undefined;
  let removeDynamic: Dispose | undefined;
  let eventCount = 0;
  let stateUpdates = 0;
  const instance = runtime();
  register(instance, 'example', {}, async (host) => {
    context = host;
    removeDynamic = registerContributions(host, {
      commands: [
        {
          id: 'example.dynamic',
          title: '动态',
          execute: async () => ({ data: true, logId: null }),
        },
      ],
    });
    extensionAccess(host).subscribeEvent('host.ready', () => {
      ++eventCount;
    });
    extensionAccess(host).subscribeState('example.counter', () => {
      ++stateUpdates;
    });
    extensionAccess(host).setState('example.counter', 1);
  });
  await instance.webPlugins.load('example');
  assert.equal(stateUpdates, 1);
  assert.equal(extensionAccess(context).getState('example.counter'), 1);
  assert.throws(() => extensionAccess(context).setState('other.counter', 2), /命名空间/);
  assert.throws(() => extensionAccess(context).emitEvent('host.fake', null), /命名空间/);
  extensionAccess(instance.host).emitEvent('host.ready', {});
  assert.equal(eventCount, 1);
  assert.equal(
    (await instance.extensions.executeCommand('example.dynamic', null, signal())).data,
    true,
  );
  assert.ok(removeDynamic);
  await removeDynamic();
  assert.equal(instance.extensions.catalog().commands.length, 0);
  await instance.webPlugins.unload('example');
  extensionAccess(instance.host).emitEvent('host.ready', {});
  assert.equal(eventCount, 1);
  assert.throws(() => extensionAccess(context).getState('example.counter'), /撤销/);
  await instance.webPlugins.load('example');
  assert.equal(extensionAccess(context).getState('example.counter'), 1);
  await instance.dispose();
});

test('跨插件版本化公开服务可调用，发布插件卸载后消费者入口仍存在但服务不可用', async () => {
  const instance = runtime();
  register(instance, 'provider', {
    services: [
      {
        id: 'provider.echo',
        version: '1',
        invoke: async (input) => ({ data: input, logId: 'service-log' }),
      },
    ],
  });
  register(instance, 'consumer', {
    commands: [
      {
        id: 'consumer.use',
        title: '使用服务',
        execute: (input, context, caller) =>
          extensionAccess(context).callService('provider.echo', '1', input, caller),
      },
    ],
  });
  await instance.webPlugins.load('provider');
  await instance.webPlugins.load('consumer');
  assert.equal(
    (await instance.extensions.executeCommand('consumer.use', 'value', signal())).logId,
    'service-log',
  );
  await instance.webPlugins.unload('provider');
  await assert.rejects(instance.extensions.executeCommand('consumer.use', null, signal()), /服务/);
  assert.equal(instance.extensions.catalog().commands.length, 1);
  await instance.dispose();
});

test('跨插件在途服务在提供者卸载时取消，重载不复活旧上下文或旧结果，消费者继续运行', async () => {
  const entered = deferred<{ context: HostContext; caller: AbortSignal }>();
  const oldResponse = deferred<HostResult<JsonValue>>();
  const observed: JsonValue[] = [];
  const instance = runtime();
  let providerLoads = 0;
  let consumerContext: HostContext | undefined;
  register(
    instance,
    'provider',
    {
      services: [
        {
          id: 'provider.value',
          version: '1',
          invoke: async (_input, context, caller) => {
            if (providerLoads === 1) {
              entered.resolve({ context, caller });
              return oldResponse.promise;
            }
            return { data: 'new', logId: 'new-service-log' };
          },
        },
      ],
    },
    async () => {
      ++providerLoads;
    },
  );
  register(
    instance,
    'consumer',
    {
      commands: [
        {
          id: 'consumer.use',
          title: '使用服务',
          execute: async (input, context, caller) => {
            const result = await extensionAccess(context).callService(
              'provider.value',
              '1',
              input,
              caller,
            );
            extensionAccess(context).setState('consumer.result', result.data);
            observed.push(result.data);
            return result;
          },
        },
      ],
    },
    async (context) => {
      consumerContext = context;
    },
  );
  const first = await instance.webPlugins.load('provider');
  await instance.webPlugins.load('consumer');
  const pending = instance.extensions.executeCommand('consumer.use', null, signal());
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  const old = await entered.promise;
  const oldCall = extensionAccess(old.context).callService;
  await instance.webPlugins.unload('provider');
  assert.equal(old.caller.aborted, true);
  assert.equal(old.context.signal.aborted, true);
  assert.ok(consumerContext);
  assert.equal(consumerContext.signal.aborted, false);
  await assert.rejects(
    instance.extensions.executeCommand('consumer.use', null, signal()),
    (error) => error instanceof HostError && error.code === 'service_unavailable',
  );
  const next = await instance.webPlugins.load('provider');
  assert.notEqual(first.generation, next.generation);
  assert.equal(
    (await instance.extensions.executeCommand('consumer.use', null, signal())).data,
    'new',
  );
  await assert.rejects(
    oldCall('provider.value', '1', null, signal()),
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  assert.throws(
    () => extensionAccess(old.context).setState('provider.late', 'old'),
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  oldResponse.resolve({ data: 'old', logId: 'old-service-log' });
  await rejected;
  assert.deepEqual(observed, ['new']);
  assert.equal(extensionAccess(consumerContext).getState('consumer.result'), 'new');
  assert.equal(
    instance.webPlugins.snapshot().find((entry) => entry.id === 'consumer')?.state,
    'loaded',
  );
  await instance.dispose();
});

test('页面模块退出仅取消挂载子生命周期，重新进入可重挂载，插件卸载撤销所有入口', async () => {
  const target = dom();
  const contexts: HostContext[] = [];
  let mounts = 0;
  let releases = 0;
  const instance = runtime({ moduleTarget: (route) => (route === '/module' ? target : null) });
  register(instance, 'example', {
    modules: [
      {
        id: 'example.module',
        title: '模块',
        route: '/module',
        mount: async (root, context) => {
          ++mounts;
          contexts.push(context);
          root.textContent = '模块内容';
          return () => {
            ++releases;
          };
        },
      },
    ],
    commands: [
      {
        id: 'example.active',
        title: '运行状态',
        execute: async () => ({ data: true, logId: null }),
      },
    ],
  });
  await instance.webPlugins.load('example');
  await instance.extensions.mountModule('example.module');
  await instance.extensions.mountModule('example.module');
  assert.equal(mounts, 1);
  assert.equal(target.children.length, 1);
  const exit = instance.extensions.unmount('example.module');
  assert.equal(contextAt(contexts, 0).signal.aborted, true);
  assert.equal(target.children.length, 0);
  await exit;
  assert.equal(releases, 1);
  assert.equal(instance.extensions.catalog().modules.length, 1);
  assert.equal(
    (await instance.extensions.executeCommand('example.active', null, signal())).data,
    true,
  );
  await instance.extensions.mountModule('example.module');
  assert.equal(mounts, 2);
  assert.equal(contextAt(contexts, 1).signal.aborted, false);
  await instance.webPlugins.unload('example');
  assert.equal(contextAt(contexts, 1).signal.aborted, true);
  assert.equal(releases, 2);
  assert.equal(target.children.length, 0);
  assert.equal(instance.extensions.catalog().modules.length, 0);
  await instance.dispose();
});

test('路由/命名冲突和激活失败回滚贡献，不影响已加载插件', async () => {
  const instance = runtime();
  const module = (id: string): ModuleContribution => ({
    id,
    title: '模块',
    route: '/shared',
    mount: async () => () => {},
  });
  register(instance, 'first', { modules: [module('first.page')] });
  register(instance, 'second', { modules: [module('second.page')] });
  await instance.webPlugins.load('first');
  await assert.rejects(instance.webPlugins.load('second'), /路由冲突/);
  assert.equal(instance.extensions.catalog().modules.length, 1);
  assert.throws(
    () =>
      register(instance, 'wrong', {
        commands: [
          {
            id: 'first.command',
            title: '冲突',
            execute: async () => ({ data: null, logId: null }),
          },
        ],
      }),
    /命名空间/,
  );
  register(
    instance,
    'broken',
    {
      commands: [
        { id: 'broken.command', title: '命令', execute: async () => ({ data: null, logId: null }) },
      ],
    },
    async () => {
      throw new Error('激活失败');
    },
  );
  await assert.rejects(instance.webPlugins.load('broken'), /激活失败/);
  assert.equal(instance.extensions.catalog().commands.length, 0);
  await instance.dispose();
});

test('命令晚到结果及任务钩子晚到输入被撤销，旧逻辑不进入后端', async () => {
  const commandDone = deferred<HostResult<JsonValue>>();
  const hookDone = deferred<TaskSubmission>();
  const hookEntered = deferred<void>();
  let posts = 0;
  let commandSignal: AbortSignal | undefined;
  const instance = runtime({
    transport: async () => {
      ++posts;
      return success(job());
    },
  });
  register(instance, 'example', {
    commands: [
      {
        id: 'example.late',
        title: '延迟',
        execute: async (_input, _host, caller) => {
          commandSignal = caller;
          return commandDone.promise;
        },
      },
    ],
    beforeTaskSubmit: [
      {
        id: 'example.hook',
        transform: async () => {
          hookEntered.resolve(undefined);
          return hookDone.promise;
        },
      },
    ],
  });
  await instance.webPlugins.load('example');
  const command = instance.extensions.executeCommand('example.late', null, signal());
  const commandFailure = assert.rejects(
    command,
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  const task = instance.tasks.submit({ operation: 'example.run', input: {} }, signal());
  const taskFailure = assert.rejects(
    task,
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  await hookEntered.promise;
  await instance.webPlugins.unload('example');
  assert.ok(commandSignal);
  assert.equal(commandSignal.aborted, true);
  commandDone.resolve({ data: 'late', logId: null });
  hookDone.resolve({ operation: 'example.run', input: { late: true } });
  await commandFailure;
  await taskFailure;
  assert.equal(posts, 0);
  await instance.dispose();
});

test('动态撤销组件立即清理挂载根，挂载失败回滚插件其他入口', async () => {
  const root = dom();
  const instance = runtime({ componentTarget: () => root });
  let release: Dispose | undefined;
  let cleanups = 0;
  register(instance, 'example', {}, async (context) => {
    release = registerContributions(context, {
      components: [
        {
          id: 'example.dynamic',
          title: '动态组件',
          slot: 'workspace.main',
          mount: async () => () => {
            ++cleanups;
          },
        },
      ],
    });
  });
  await instance.webPlugins.load('example');
  await instance.extensions.mountComponent('example.dynamic');
  assert.ok(release);
  await release();
  assert.equal(root.children.length, 0);
  assert.equal(cleanups, 1);
  register(instance, 'broken', {
    components: [
      {
        id: 'broken.component',
        title: '失败',
        slot: 'workspace.main',
        mount: async (_root, context) => {
          context.onDispose(() => {
            ++cleanups;
          });
          throw new Error('组件失败');
        },
      },
    ],
    commands: [
      { id: 'broken.command', title: '命令', execute: async () => ({ data: null, logId: null }) },
    ],
  });
  await instance.webPlugins.load('broken');
  await assert.rejects(instance.extensions.mountComponent('broken.component'), /组件失败/);
  assert.equal(instance.extensions.catalog().commands.length, 0);
  assert.equal(root.children.length, 0);
  assert.equal(cleanups, 2);
  await instance.dispose();
});

test('已安装包每次加载使用独立运行路径，相对依赖继承合法运行代次前缀', async () => {
  const urls: string[] = [];
  let activations = 0;
  const instance = runtime({
    esmImporter: async (url) => {
      urls.push(url);
      return {
        default: {
          id: 'example',
          version: '1.0',
          apiVersion: 2,
          panels: [],
          activate: async () => {
            ++activations;
          },
        },
      };
    },
    packageEntryResolver: (descriptor, runId) =>
      `http://localhost:7031/api/v2/browser-plugins/${descriptor.id}/runs/${runId}/assets/${descriptor.entryPath}`,
  });
  instance.registerInstalledPackage({ id: 'example', version: '1.0', entryPath: 'nested/main.js' });
  await instance.webPlugins.load('example');
  await instance.webPlugins.unload('example');
  await instance.webPlugins.load('example');
  assert.equal(activations, 2);
  assert.equal(urls.length, 2);
  assert.notEqual(urls[0], urls[1]);
  const dependencies = urls.map((url) => new URL('./dependency.js', url).href);
  assert.notEqual(dependencies[0], dependencies[1]);
  assert.ok(
    dependencies.every((url) =>
      /\/runs\/[A-Za-z0-9_-]+\/assets\/nested\/dependency\.js$/.test(url),
    ),
  );
  await instance.dispose();
});

test('公开具名槽位追加和替换默认renderer，重复挂载不重复获取，卸载恢复默认渲染', async () => {
  const root = dom();
  const unrelated = root.ownerDocument.createElement('div');
  unrelated.textContent = '宿主无关资源';
  root.append(unrelated);
  let defaults = 0;
  let defaultReleases = 0;
  let componentReleases = 0;
  const adapter = await createNamedSlotAdapter([
    {
      id: 'workspace.main',
      target: root,
      renderDefault: async (target) => {
        target.textContent = `默认渲染${++defaults}`;
        return () => {
          ++defaultReleases;
        };
      },
    },
  ]);
  const instance = runtime({ slotAdapter: adapter });
  const widget = (id: string, mode: 'append' | 'replace'): ComponentContribution => ({
    id,
    title: '组件',
    slot: 'workspace.main',
    mode,
    mount: async (target) => {
      target.textContent = mode;
      return () => {
        ++componentReleases;
      };
    },
  });
  register(instance, 'append', { components: [widget('append.widget', 'append')] });
  register(instance, 'replace', { components: [widget('replace.widget', 'replace')] });
  await instance.webPlugins.load('append');
  await instance.extensions.mountComponent('append.widget');
  assert.equal(root.children.length, 3);
  assert.equal(defaultReleases, 0);
  await instance.webPlugins.load('replace');
  await Promise.all([
    instance.extensions.mountComponent('replace.widget'),
    instance.extensions.mountComponent('replace.widget'),
  ]);
  assert.equal(defaultReleases, 1);
  assert.equal(defaults, 1);
  assert.equal(
    children(root).some((child) => child.dataset.deviceforgeDefaultSlot),
    false,
  );
  assert.equal(
    instance.extensions.catalog().components.find((entry) => entry.id === 'replace.widget')?.mode,
    'replace',
  );
  await instance.webPlugins.unload('replace');
  assert.equal(defaults, 2);
  assert.equal(
    children(root).find((child) => child.dataset.deviceforgeDefaultSlot)?.textContent,
    '默认渲染2',
  );
  assert.ok(children(root).includes(unrelated));
  assert.equal(componentReleases, 1);
  await instance.webPlugins.unload('append');
  assert.equal(root.children.length, 2);
  assert.equal(componentReleases, 2);
  await instance.dispose();
  await adapter.dispose();
  assert.deepEqual(children(root), [unrelated]);
  assert.equal(defaultReleases, 2);
});

test('替换渲染冲突拒绝第二贡献，失败挂载恢复宿主默认renderer', async () => {
  const root = dom();
  let renders = 0;
  const adapter = await createNamedSlotAdapter([
    {
      id: 'workspace.main',
      target: root,
      renderDefault: async (target) => {
        target.textContent = '宿主默认';
        ++renders;
        return () => {};
      },
    },
  ]);
  const instance = runtime({ slotAdapter: adapter });
  const widget = (id: string): ComponentContribution => ({
    id,
    title: '替换',
    slot: 'workspace.main',
    mode: 'replace',
    mount: async () => () => {},
  });
  register(instance, 'first', { components: [widget('first.widget')] });
  register(instance, 'second', { components: [widget('second.widget')] });
  await instance.webPlugins.load('first');
  await instance.extensions.mountComponent('first.widget');
  await instance.webPlugins.load('second');
  await assert.rejects(instance.extensions.mountComponent('second.widget'), /替换渲染/);
  assert.equal(instance.extensions.catalog().components.length, 1);
  assert.equal(renders, 1);
  await instance.webPlugins.unload('first');
  assert.equal(renders, 2);
  register(instance, 'broken', {
    components: [
      {
        ...widget('broken.widget'),
        mount: async () => {
          throw new Error('替换失败');
        },
      },
    ],
  });
  await instance.webPlugins.load('broken');
  await assert.rejects(instance.extensions.mountComponent('broken.widget'), /替换失败/);
  assert.equal(root.children[0]?.textContent, '宿主默认');
  assert.equal(renders, 3);
  assert.equal(instance.extensions.catalog().components.length, 0);
  await instance.dispose();
  await adapter.dispose();
});

test('可运行任务实验样例只用公开SDK执行命令与输入钩子并保留真实响应日志', async () => {
  let posted: unknown;
  const configurations = browserConfigurationServer();
  const instance = runtime({
    transport: async (url, init) => {
      if (requestUrl(url).pathname.startsWith('/api/v2/browser-plugin-configurations/'))
        return configurations.transport(url, init);
      posted = submittedBody(init);
      return success(job(), 'sample-request-log');
    },
  });
  instance.webPlugins.register({
    id: 'task-lab',
    trusted: true,
    plugin: createTaskLab('example.run'),
  });
  await instance.webPlugins.load('task-lab');
  const result = await instance.extensions.executeCommand(
    'task-lab.submit',
    { value: 42 },
    signal(),
  );
  assert.equal(result.logId, 'sample-request-log');
  assert.deepEqual(posted, {
    operation: 'example.run',
    input: { source: 'task-lab', value: { value: 42 } },
  });
  await instance.webPlugins.unload('task-lab');
  assert.equal(instance.extensions.catalog().commands.length, 0);
  await instance.dispose();
});

test('插件钩子和服务返回类实例或循环对象时拒绝，不发送无效任务', async () => {
  let requests = 0;
  const instance = runtime({
    transport: async () => {
      ++requests;
      return success(job());
    },
  });
  // 非法第三方返回值经unknown加载边界进入，仍由真实运行时校验拒绝。
  instance.webPlugins.register({
    id: 'invalid',
    trusted: true,
    loader: async () => ({
      id: 'invalid',
      version: '1.0',
      apiVersion: 2,
      panels: [],
      contributions: {
        services: [
          {
            id: 'invalid.service',
            version: '1',
            invoke: async () => ({ data: new Date(), logId: null }),
          },
        ],
        beforeTaskSubmit: [
          {
            id: 'invalid.hook',
            transform: async () => {
              const cyclic: { self?: unknown } = {};
              cyclic.self = cyclic;
              return { operation: 'example.run', input: cyclic };
            },
          },
        ],
      },
    }),
  });
  await instance.webPlugins.load('invalid');
  await assert.rejects(
    instance.extensions.callService('invalid.service', '1', null, signal()),
    /返回值无效/,
  );
  await assert.rejects(
    instance.tasks.submit({ operation: 'example.run', input: null }, signal()),
    /无效输入/,
  );
  assert.equal(requests, 0);
  await instance.dispose();
});

test('组件挂载排队撤销与进行中撤销及时关闭子信号，不卸载整个插件', async () => {
  const root = dom();
  const done = deferred<void>();
  const began = deferred<HostContext>();
  let mounts = 0;
  let releases = 0;
  const instance = runtime({ componentTarget: () => root });
  register(instance, 'example', {
    components: [
      {
        id: 'example.widget',
        title: '组件',
        slot: 'workspace.main',
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
  });
  await instance.webPlugins.load('example');
  const queued = instance.extensions.mountComponent('example.widget');
  const queuedFailure = assert.rejects(queued, /排队扩展/);
  await instance.extensions.unmount('example.widget');
  await queuedFailure;
  assert.equal(mounts, 0);
  const pending = instance.extensions.mountComponent('example.widget');
  const pendingFailure = assert.rejects(
    pending,
    (error) => error instanceof HostError && error.kind === 'cancelled',
  );
  const context = await began.promise;
  const removed = instance.extensions.unmount('example.widget');
  assert.equal(context.signal.aborted, true);
  assert.equal(root.children.length, 0);
  done.resolve(undefined);
  await pendingFailure;
  await removed;
  assert.equal(releases, 1);
  assert.equal(instance.webPlugins.snapshot()[0]?.state, 'loaded');
  assert.equal(instance.extensions.catalog().components.length, 1);
  await instance.dispose();
});
