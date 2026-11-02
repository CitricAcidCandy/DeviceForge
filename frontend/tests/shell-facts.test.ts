import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { Dispose, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import { deferred } from './fixtures.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ShellState } from '../plugins/default-shell/src/controller.ts';

const imports = registerCompositionStartupImports();
const { createShellFacts } = await import('../plugins/default-shell/src/facts.ts');
after(() => imports.dispose());
const { ShellStatus } = await import('../plugins/default-shell/src/chrome.tsx');

async function settle() { for (let i = 0; i < 6; i++) await new Promise<void>((done) => setImmediate(done)); }
function fixture(call: NonNullable<HostContext['services']>['call']) {
  const owner = new AbortController(), events = new Map<string, Set<() => void>>();
  const features = new Map<string, { stop: Dispose; signal: AbortController }>();
  const forbidden = async (): Promise<never> => { throw new Error('状态栏不得派发业务或读取私有状态'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, submit: forbidden, getJob: forbidden, cancelJob: forbidden,
    listOperations: forbidden, subscribeOperations: () => () => {}, onDispose: (release) => release,
    services: { catalog: () => [], diagnostics: () => [], call, callTyped: forbidden,
      whenAvailable(id, _required, setup) {
        const signal = new AbortController();
        const feature = { ...context, signal: AbortSignal.any([owner.signal, signal.signal]) };
        const disposal = Promise.resolve(setup(feature));
        const stop = () => { signal.abort(); return disposal.then((release) => release?.()); };
        features.set(id, { stop, signal }); return stop;
      },
    },
    extensions: { catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: forbidden, callService: forbidden, getState: () => undefined, setState: () => {},
      subscribeState: () => () => {}, emitEvent: () => {},
      subscribeEvent(name, listener) {
        const entries = events.get(name) ?? new Set<() => void>(); events.set(name, entries);
        const notify = () => listener({ name, data: null, pluginId: 'host', generation: 0 });
        entries.add(notify); return () => { entries.delete(notify); };
      },
    },
  };
  return { context, features, emit: (name: string) => { for (const notify of events.get(name) ?? []) notify(); },
    listeners: () => [...events.values()].reduce((total, entries) => total + entries.size, 0),
    dispose() { owner.abort(); } };
}

test('外壳事实只读已有公开服务，插件数包含无视图插件而非数视图提供者', async () => {
  const calls: string[] = [];
  const f = fixture(async (ref, input) => {
    calls.push(ref.id); assert.deepEqual(input, { action: ref.id === 'host.connection' ? 'status' : 'snapshot' });
    const data: JsonValue = ref.id === 'host.connection'
      ? { baseUrl: 'http://127.0.0.1:7031', canReconnect: true }
      : { snapshotVersion: 1, runtime: [{ id: 'no_view', state: 'loaded' }, { id: 'visible', state: 'loaded' }, { id: 'next', state: 'loading' }] };
    return { data, logId: 'facts-log' };
  });
  const model = createShellFacts(f.context);
  try {
    assert.deepEqual(calls, []); model.start(); await settle();
    assert.equal(model.snapshot().endpoint.value, 'http://127.0.0.1:7031');
    assert.equal(model.snapshot().plugins.value, 2); assert.equal(model.snapshot().plugins.state, 'confirmed');
    assert.deepEqual(calls.sort(), ['host.browser-plugins', 'host.connection']);
    assert.equal(f.listeners(), 1);
  } finally { await model.dispose(); f.dispose(); }
  assert.equal(f.listeners(), 0);
});

test('浏览器贡献事件只刷新运行事实，失败留旧观测而不冒充当前成功且可重读', async () => {
  let count = 0;
  const f = fixture(async (ref) => {
    if (ref.id === 'host.connection') return { data: { baseUrl: 'http://localhost:7031', canReconnect: false }, logId: null };
    if (++count === 2) throw new HostError('network', 'offline', '目录读取失败', 'failed-log');
    return { data: { snapshotVersion: 1, runtime: count < 3 ? [{ id: 'one', state: 'loaded' }] : [] }, logId: `read-${count}` };
  });
  const model = createShellFacts(f.context);
  try {
    model.start(); await settle(); f.emit('host.browser-plugins.changed'); await settle();
    assert.equal(model.snapshot().plugins.value, 1); assert.equal(model.snapshot().plugins.state, 'stale');
    assert.equal(model.snapshot().plugins.logId, 'failed-log');
    model.refresh(); await settle(); assert.equal(model.snapshot().plugins.value, 0);
    assert.equal(model.snapshot().plugins.state, 'confirmed');
  } finally { await model.dispose(); f.dispose(); }
});

test('服务撤销及外壳释放不等待忽略取消的旧查询，旧结果不污染后续事实', async () => {
  const late = deferred<{ data: JsonValue; logId: null }>();
  const f = fixture(async (ref) => ref.id === 'host.connection'
    ? { data: { baseUrl: 'http://localhost:7031', canReconnect: true }, logId: null } : late.promise);
  const model = createShellFacts(f.context);
  model.start(); await settle();
  const feature = [...f.features].find(([id]) => id.includes('plugins'))?.[1]; assert.ok(feature);
  await feature.stop(); await settle();
  assert.equal(model.snapshot().plugins.state, 'waiting'); assert.equal(model.snapshot().plugins.value, null);
  await model.dispose();
  const previous = model.snapshot(); late.resolve({ data: { snapshotVersion: 1, runtime: [] }, logId: null });
  await settle(); assert.equal(model.snapshot(), previous); assert.equal(f.listeners(), 0); f.dispose();
});

test('服务地址不得泄露凭据，重复或无效插件目录不当成零插件成功', async () => {
  const f = fixture(async (ref) => ({ data: ref.id === 'host.connection'
    ? { baseUrl: 'http://name:secret@localhost:7031', canReconnect: false }
    : { snapshotVersion: 1, runtime: [{ id: 'one', state: 'loaded' }, { id: 'one', state: 'loaded' }] }, logId: null }));
  const model = createShellFacts(f.context);
  try {
    model.start(); await settle();
    assert.equal(model.snapshot().endpoint.value, null); assert.equal(model.snapshot().endpoint.state, 'failed');
    assert.equal(model.snapshot().plugins.value, null); assert.equal(model.snapshot().plugins.state, 'failed');
    assert.doesNotMatch(JSON.stringify(model.snapshot()), /secret|name:/);
  } finally { await model.dispose(); f.dispose(); }
});

test('原状态栏显示已确认地址和真实插件数，失效观测明确标旧而不数视图或伪造零', () => {
  const state: ShellState = { pages: [], routeConflicts: [], visited: [], route: '/', current: null,
    available: false, compact: false, compactView: null, notice: null, preparing: 0,
    model: { revision: 0, catalog: { pages: [], views: [], workspaces: [] }, instances: [], layouts: [] } };
  const connection = { state: 'connected', text: '服务器已连接', error: null, logId: null } satisfies import('../plugins/default-shell/src/connection.ts').ShellConnection;
  const current = renderToStaticMarkup(createElement(ShellStatus, { state, connection, facts: {
    endpoint: { value: 'http://127.0.0.1:7031', state: 'confirmed', error: null, logId: null },
    plugins: { value: 19, state: 'confirmed', error: null, logId: null },
  } }));
  assert.match(current, /127\.0\.0\.1:7031/); assert.match(current, /插件 19 已加载/);
  assert.doesNotMatch(current, /界面插件|旧观测/);
  const stale = renderToStaticMarkup(createElement(ShellStatus, { state, connection, facts: {
    endpoint: { value: null, state: 'waiting', error: null, logId: null },
    plugins: { value: 19, state: 'stale', error: '目录已断开', logId: 'stale-log' },
  } }));
  assert.match(stale, /插件 19（旧观测）/); assert.doesNotMatch(stale, /插件 19 已加载/);
});
