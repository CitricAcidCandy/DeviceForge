import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { deferred } from './fixtures.ts';
import type { Dispose, HostContext, ServiceContribution } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const heavy: string[] = [];
const loading = deferred<void>(), entered = deferred<void>();
const key = '__deviceforgeAiModuleUnit';
const previousGate = Object.getOwnPropertyDescriptor(globalThis, key);
Object.defineProperty(globalThis, key, { configurable: true, value: loading.promise });
const imports = registerCompositionStartupImports();
const observer = registerHooks({
  load(url, context, next) {
    if (/\/plugins\/ai\/src\/(?:model\/|services\.ts|instances\.ts|view\.tsx)/.test(url)) heavy.push(url);
    if (url.endsWith('/plugins/ai/src/public-services/runtime.ts')) {
      entered.resolve();
      return { format: 'module-typescript', shortCircuit: true,
        source: `await Reflect.get(globalThis, '${key}');\n${readFileSync(new URL(url), 'utf8')}` };
    }
    return next(url, context);
  },
});
after(() => {
  loading.resolve(); observer.deregister(); imports.dispose();
  if (previousGate) Object.defineProperty(globalThis, key, previousGate); else Reflect.deleteProperty(globalThis, key);
});
const { default: createAiPlugin } = await import('../plugins/ai/src/index.ts');

function fixture() {
  const lifetime = new AbortController(), registry = createWorkspaceRegistry();
  const services = new Map<string, ServiceContribution>(), releases: Dispose[] = [];
  let requests = 0;
  const unavailable = async (): Promise<never> => { requests++; throw new Error('登记与空快照不得派发业务请求'); };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal,
    ui: registry.access({ pluginId: 'deferred_ai', generation: 1, signal: lifetime.signal }),
    transport: { request: unavailable, bytes: unavailable, stream: unavailable },
    onDispose(release) { releases.push(release); return release; }, onCleanup: () => () => {},
    listOperations: unavailable, submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    subscribeOperations: () => () => {},
    extensions: {
      catalog: () => ({ commands: [], components: [], services: [], modules: [] }),
      executeCommand: unavailable, callService: unavailable, getState: () => undefined, setState() {},
      emitEvent() {}, subscribeEvent: () => () => {}, subscribeState: () => () => {},
      register(value) {
        for (const entry of value.services ?? []) services.set(entry.id, entry);
        return () => { for (const entry of value.services ?? []) services.delete(entry.id); };
      },
    },
  };
  return { context, registry, services, requests: () => requests,
    async close() { lifetime.abort(); for (const release of releases.reverse()) await release(); registry.dispose(); },
  };
}

test('AI插件解析和激活只登记页面服务，不载入SDK或CLI业务模型', async () => {
  const f = fixture();
  try {
    await createAiPlugin({ id: 'deferred_ai', version: '1', apiVersion: 2 }).activate?.(f.context);
    assert.equal(f.registry.catalog().pages[0]?.route, '/ai');
    assert.deepEqual([...f.services.keys()].sort(), ['deferred_ai.sdk', 'deferred_ai.sdk.stream']);
    assert.deepEqual(heavy, [], '仅打开设备工作台时不应解析AI模型');
    assert.equal(f.requests(), 0);
  } finally { await f.close(); }
});

test('AI模块加载中的取消及卸载及时结束，独立调用继续且不重放旧请求', async () => {
  const stopped = fixture(), cancelled = fixture(), active = fixture();
  for (const f of [stopped, cancelled, active])
    await createAiPlugin({ id: 'deferred_ai', version: '1', apiVersion: 2 }).activate?.(f.context);
  const service = (f: ReturnType<typeof fixture>) => {
    const value = f.services.get('deferred_ai.sdk.stream'); assert.ok(value); return value;
  };
  const caller = new AbortController();
  try {
    const old = service(stopped).invoke({ action: 'snapshot' }, stopped.context, new AbortController().signal);
    const oldEnded = assert.rejects(old, (error: unknown) => error instanceof Error);
    const cancel = service(cancelled).invoke({ action: 'snapshot' }, cancelled.context, caller.signal);
    const cancelEnded = assert.rejects(cancel, (error: unknown) => error instanceof Error);
    const result = service(active).invoke({ action: 'snapshot' }, active.context, new AbortController().signal);
    await entered.promise;
    caller.abort(); await stopped.close();
    await Promise.all([oldEnded, cancelEnded]);
    loading.resolve();
    const current = await result;
    assert.ok(current.data && typeof current.data === 'object' && !Array.isArray(current.data));
    assert.equal(current.data.session, null);
    assert.equal(stopped.requests() + cancelled.requests() + active.requests(), 0);
    assert.equal(stopped.services.size, 0); assert.equal(active.services.size, 2);
  } finally { loading.resolve(); await stopped.close(); await cancelled.close(); await active.close(); }
});

test('AI首次服务调用沿真实模型返回空快照，卸载后的旧入口不恢复或联网', async () => {
  const f = fixture();
  await createAiPlugin({ id: 'deferred_ai', version: '1', apiVersion: 2 }).activate?.(f.context);
  const service = f.services.get('deferred_ai.sdk.stream'); assert.ok(service);
  try {
    const result = await service.invoke({ action: 'snapshot' }, f.context, new AbortController().signal);
    assert.ok(result.data && typeof result.data === 'object' && !Array.isArray(result.data));
    assert.equal(result.data.session, null);
    assert.ok(heavy.some((url) => url.endsWith('/services.ts')));
    assert.equal(f.requests(), 0);
  } finally { await f.close(); }
  await assert.rejects(Promise.resolve().then(() => service.invoke({ action: 'snapshot' }, f.context,
    new AbortController().signal)), (error: unknown) => error instanceof Error);
  assert.equal(f.services.size, 0); assert.equal(f.requests(), 0);
});
