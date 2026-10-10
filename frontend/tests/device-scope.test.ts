import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginScope } from '../src/plugins/scope.ts';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DeviceAccess, DeviceDirectory, DeviceProviderInfo, DeviceSnapshot, HostContext, HostResult, Job, PanelContribution } from '../src/plugin-sdk/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';
import { directory, provider } from './device-fixtures.ts';
import { dom } from './dom-fixtures.ts';

const queuedJob: Job = { id: 'device-job', operation: 'example.read', status: 'queued', result: null, error: null };
const observedDirectory: DeviceDirectory = { provider: { id: 'example', generation: 'g1', version: '1.0', definition: {
  apiVersion: 1, platform: '模拟平台', discoverOperation: 'example.discover', capabilities: [],
} }, observedAt: 1, discoveryJobId: 'discovery-job', devices: [] };
const emptySnapshot: DeviceSnapshot = { providers: [], directories: [], selection: null, selected: null };

function environment(devices?: DeviceAccess): { lifetime: AbortController; host: HostContext } {
  const lifetime = new AbortController();
  const job: HostResult<Job> = { data: queuedJob, logId: 'device-log' };
  return { lifetime, host: { apiVersion: 2, signal: lifetime.signal,
    listOperations: async () => ({ data: [], logId: null }), submit: async () => job, getJob: async () => job, cancelJob: async () => job,
    subscribeOperations: () => () => {}, onDispose: () => () => {}, ...(devices ? { devices } : {}),
  } };
}
function access(overrides: Partial<DeviceAccess> = {}): DeviceAccess {
  return { refreshProviders: async () => ({ data: [], logId: 'providers-log' }), refreshDirectories: async () => ({ data: [], logId: 'directories-log' }),
    refreshProvider: async () => ({ data: observedDirectory, logId: 'refresh-log' }), invoke: async () => ({ data: queuedJob, logId: 'invoke-log' }),
    select: () => {}, snapshot: () => ({ providers: [], directories: [], selection: null, selected: null }), subscribe: () => () => {}, ...overrides,
  };
}
function deviceAccess(context: HostContext): DeviceAccess {
  assert.ok(context.devices, '此测试要求上下文包含设备能力'); return context.devices;
}

async function cancelledMountedRequest<T>(invoke: (devices: DeviceAccess, caller: AbortSignal) => Promise<HostResult<T>>,
  hold: (response: Promise<HostResult<T>>, started: (signal: AbortSignal) => void) => Partial<DeviceAccess>, late: T): Promise<void> {
  const started = deferred<AbortSignal>(); const response = deferred<HostResult<T>>();
  const { host } = environment(access(hold(response.promise, (caller) => started.resolve(caller))));
  const instance = createPluginScope(host), mounted = createPluginScope(instance.context), caller = signal();
  const waiting = invoke(deviceAccess(mounted.context), caller);
  const rejected = assert.rejects(waiting, (error) => error instanceof HostError && error.kind === 'cancelled');
  const combined = await started.promise, closing = mounted.dispose();
  assert.equal(combined.aborted, true); assert.equal(instance.context.signal.aborted, false); assert.equal(caller.aborted, false);
  response.resolve({ data: late, logId: 'late-device-log' }); await rejected; await closing; await instance.dispose();
}

test('SDK v2 的 devices 可省略，旧宿主和插件继续运行', async () => {
  const { host } = environment(); const scope = createPluginScope(host);
  assert.equal(scope.context.apiVersion, 2); assert.equal('devices' in scope.context, false); await scope.dispose();
});

test('插件设备四类请求均合并实例/子挂载信号，子卸载拒绝晚到但保留实例', async () => {
  await cancelledMountedRequest<readonly DeviceProviderInfo[]>((devices, caller) => devices.refreshProviders(caller),
    (response, started) => ({ refreshProviders: async (caller) => { started(caller); return response; } }), []);
  await cancelledMountedRequest<readonly DeviceDirectory[]>((devices, caller) => devices.refreshDirectories(caller),
    (response, started) => ({ refreshDirectories: async (caller) => { started(caller); return response; } }), []);
  await cancelledMountedRequest<DeviceDirectory>((devices, caller) => devices.refreshProvider('example', 'g1', caller),
    (response, started) => ({ refreshProvider: async (_id, _generation, caller) => { started(caller); return response; } }), observedDirectory);
  await cancelledMountedRequest<Job>((devices, caller) => devices.invoke({ providerId: 'example', generation: 'g1', deviceId: 'same', capability: 'read', version: 1, input: {} }, caller),
    (response, started) => ({ invoke: async (_action, caller) => { started(caller); return response; } }), queuedJob);
});

test('设备调用保留 caller 取消并阻止取消前入网，旧插件上下文不能继续选设备', async () => {
  const response = deferred<HostResult<readonly DeviceProviderInfo[]>>(); const started = deferred<AbortSignal>(); let requests = 0;
  const { host } = environment(access({ refreshProviders: async (caller) => { ++requests; started.resolve(caller); return response.promise; } }));
  const scope = createPluginScope(host); const caller = new AbortController();
  const waiting = deviceAccess(scope.context).refreshProviders(caller.signal);
  const rejected = assert.rejects(waiting, (error) => error instanceof HostError && error.kind === 'cancelled');
  const combined = await started.promise; caller.abort(); assert.equal(combined.aborted, true);
  response.resolve({ data: [], logId: 'cancelled-log' }); await rejected;
  await assert.rejects(deviceAccess(scope.context).refreshProviders(caller.signal), (error) => error instanceof HostError && error.kind === 'cancelled');
  assert.equal(requests, 1); await scope.dispose();
  assert.throws(() => deviceAccess(scope.context).select(null), (error) => error instanceof HostError && error.kind === 'cancelled');
});

test('实例卸载同步取消嵌套设备请求并撤销订阅，晚通知不进入旧面板', async () => {
  const listeners = new Set<(snapshot: DeviceSnapshot) => void>(); const response = deferred<HostResult<readonly DeviceDirectory[]>>(); const started = deferred<AbortSignal>(); let notifications = 0;
  const { host } = environment(access({ subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshDirectories: async (caller) => { started.resolve(caller); return response.promise; },
  }));
  const instance = createPluginScope(host); const mounted = createPluginScope(instance.context);
  deviceAccess(mounted.context).subscribe(() => { ++notifications; }); const late = [...listeners][0]; assert.ok(late);
  const waiting = deviceAccess(mounted.context).refreshDirectories(signal());
  const rejected = assert.rejects(waiting, (error) => error instanceof HostError && error.kind === 'cancelled');
  const combined = await started.promise; const closing = instance.dispose();
  assert.equal(combined.aborted, true); assert.equal(listeners.size, 0); late(emptySnapshot); assert.equal(notifications, 0);
  response.resolve({ data: [], logId: 'late-log' }); await rejected; await closing; await mounted.dispose();
});

test('旧实例与挂载上下文 devices 的状态/订阅全入口均检查 close，手动订阅释放仅一次', async () => {
  let releases = 0;
  const { host } = environment(access({ subscribe: () => () => { ++releases; } }));
  const instance = createPluginScope(host); const mounted = createPluginScope(instance.context);
  const release = deviceAccess(mounted.context).subscribe(() => {}); await release(); await release(); assert.equal(releases, 1);
  await instance.dispose();
  for (const scope of [instance, mounted]) {
    for (const read of [() => deviceAccess(scope.context).snapshot(), () => deviceAccess(scope.context).select(null), () => deviceAccess(scope.context).subscribe(() => {})]) {
      assert.throws(read, (error) => error instanceof HostError && error.kind === 'cancelled');
    }
  }
  await mounted.dispose(); assert.equal(releases, 1);
});

test('实际 runtime 插件/面板/组件/模块卸载取消设备 HTTP 与订阅，旧结果不进入新挂载', async () => {
  for (const kind of ['instance', 'panel', 'component', 'module']) {
    const target = dom();
    const response = deferred<Response>(); const started = deferred<AbortSignal>();
    const ready = deferred<{ context: HostContext; rejected: Promise<void> }>(); let changes = 0; let resultWrites = 0;
    const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => target, componentTarget: () => target, moduleTarget: () => target,
      transport: async (input, init) => {
        if (requestUrl(input).pathname.endsWith('/refresh')) {
          const caller = init?.signal; assert.ok(caller); started.resolve(caller); return response.promise;
        }
        return success(requestUrl(input).pathname.endsWith('device-providers') ? [provider()] : [directory()]);
      },
    });
    await runtime.devices.refreshDirectories(signal());
    const start = (context: HostContext) => {
      deviceAccess(context).subscribe(() => { ++changes; });
      const waiting = deviceAccess(context).refreshProvider('example', 'g1', signal()).then((value) => { ++resultWrites; return value; });
      const rejected = assert.rejects(waiting, (error) => error instanceof HostError && error.kind === 'cancelled');
      ready.resolve({ context, rejected }); return () => {};
    };
    const mount: PanelContribution['mount'] = async (_root, context) => start(context);
    runtime.webPlugins.register({ id: 'example', trusted: true, plugin: { id: 'example', version: '1', apiVersion: 2,
      panels: kind === 'panel' ? [{ id: 'example.panel', title: '设备面板', mount }] : [],
      ...(kind === 'instance' ? { activate: async (context) => { start(context); } } : {}),
      contributions: kind === 'component' ? { components: [{ id: 'example.widget', title: '设备组件', slot: 'main', mount }] }
        : kind === 'module' ? { modules: [{ id: 'example.page', title: '设备模块', route: '/devices', mount }] } : {},
    } });
    await runtime.webPlugins.load('example');
    if (kind === 'panel') await runtime.webPlugins.mount('example', 'example.panel');
    if (kind === 'component') await runtime.extensions.mountComponent('example.widget');
    if (kind === 'module') await runtime.extensions.mountModule('example.page');
    const pending = await ready.promise; const httpSignal = await started.promise;
    if (kind === 'instance') await runtime.webPlugins.unload('example');
    else if (kind === 'panel') await runtime.webPlugins.unmount('example', 'example.panel');
    else await runtime.extensions.unmount(kind === 'component' ? 'example.widget' : 'example.page');
    assert.equal(httpSignal.aborted, true); await pending.rejected;
    assert.equal(target.children.length, 0);
    if (kind !== 'instance') assert.equal(runtime.webPlugins.snapshot()[0]?.state, 'loaded');
    const before = changes; await runtime.devices.refreshProviders(signal()); assert.equal(changes, before);
    response.resolve(success(directory())); assert.equal(resultWrites, 0);
    assert.throws(() => deviceAccess(pending.context).snapshot(), (error) => error instanceof HostError && error.kind === 'cancelled');
    await runtime.dispose();
  }
});
