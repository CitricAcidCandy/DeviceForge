import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DebugAccess, DebugDataSnapshot, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { createLocalDebugger } from '../src/app/debugger-local/index.ts';
import type { LocalDebugger } from '../src/app/debugger-local/index.ts';

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function host(signal: AbortSignal): HostContext {
  return { apiVersion: 2, signal, listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('测试不提交业务'); }, getJob: async () => { throw new Error('测试不查询任务'); },
    cancelJob: async () => { throw new Error('测试不取消任务'); }, subscribeOperations: () => () => {}, onDispose: () => () => {},
  };
}
async function fixture() {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main'); assert.ok(root);
  const lifetime = new AbortController();
  const extensions = createExtensionRegistry();
  const accesses = new Map<string, DebugAccess>();
  let local: LocalDebugger | undefined;
  const manager = createPluginManager({ host: host(lifetime.signal), extensionRegistry: extensions, panelTarget: () => root,
    debugForPlugin(id, generation, scope) {
      assert.ok(local);
      const access = local.attach(id, String(generation), scope);
      accesses.set(id, access);
      return access;
    },
  });
  local = createLocalDebugger({ document: dom.window.document, signal: lifetime.signal, manager: () => manager, extensions });
  const debuggerLocal = local;
  async function load(id: string) {
    manager.register({ id, trusted: true, plugin: { id, version: '1', apiVersion: 2, panels: [] } });
    return manager.load(id);
  }
  const loaded = await load('example');
  const target = { plugin_id: 'example', generation: String(loaded.generation) };
  const access = accesses.get('example'); assert.ok(access);
  const execute = (tool: string, parameters: JsonValue = {}) => debuggerLocal.execute(tool, target, parameters, lifetime.signal);
  return { lifetime, manager, local: debuggerLocal, access, target, load, execute,
    async close() { debuggerLocal.dispose(); await manager.dispose(); extensions.dispose(); dom.window.close(); } };
}
function code(expected: string) {
  return (error: unknown) => error instanceof HostError && error.code === `debugger_${expected}`;
}

test('本地数据工具要求当前明确目标，空目录不冒充没有内部数据', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.execute('data_catalog'), code('target_not_selected'));
    f.local.select([f.target]);
    const catalog = object(await f.execute('data_catalog'));
    assert.deepEqual(catalog['sources'], []);
    assert.equal(catalog['source'], 'plugin-registered');
    const capability = object(object(await f.execute('inspect'))['capabilities']);
    assert.equal(capability['data_catalog'], true); assert.equal(capability['data_read'], false);
  } finally { await f.close(); }
});

test('本地数据回执保留业务 value 并报告延迟生效，不把保存当运行态切换', async () => {
  const f = await fixture();
  try {
    f.local.select([f.target]);
    let state: DebugDataSnapshot = { revision: 'r1', value: { value: '原名' } };
    const register = f.access.registerDataSource; assert.ok(register);
    register({ id: 'alias', label: '应用别名', schema: { type: 'object', properties: { value: { type: 'string' } } },
      persistence: 'persistent', applyPolicy: 'reload', read: async () => state,
      write: async request => { state = { revision: 'r2', value: request.value }; } });
    const initial = object(await f.execute('data_read', { source_id: 'alias' }));
    assert.deepEqual(initial['value'], { value: '原名' }); assert.equal(initial['writable'], true);
    const revision = initial['revision']; assert.equal(typeof revision, 'string');
    assert.ok(typeof revision === 'string');
    await assert.rejects(f.execute('data_write', { source_id: 'alias', expected_revision: revision, value: { value: '新名' } }), code('confirmation_required'));
    const saved = object(await f.execute('data_write', { source_id: 'alias', expected_revision: revision, value: { value: '新名' }, confirmed: true }));
    assert.deepEqual(saved['value'], { value: '新名' });
    assert.notEqual(saved['revision'], revision); assert.equal(saved['apply_policy'], 'reload'); assert.equal(saved['runtime_applied'], 'pending');
    const inspected = object(await f.execute('inspect'));
    assert.equal(object(inspected['capabilities'])['data_write'], true);
    const events = object(inspected['debug'])['events']; assert.ok(Array.isArray(events));
    assert.equal(object(events.at(-1))['name'], 'debugger.data_write');
    assert.ok(!JSON.stringify(events).includes('新名'));
  } finally { await f.close(); }
});

test('登记降级记录失败次数，跨目标及卸载后的旧访问不能读取源', async () => {
  const f = await fixture();
  try {
    f.local.select([f.target]);
    const register = f.access.registerDataSource; assert.ok(register);
    const definition = { id: 'state', label: '状态', schema: true, persistence: 'memory', applyPolicy: 'immediate',
      read: async () => ({ revision: 'r1', value: 1 }) } satisfies Parameters<typeof register>[0];
    register(definition); assert.doesNotThrow(() => register(definition));
    assert.equal(object(await f.execute('inspect'))['registration_failures'], 1);
    const other = await f.load('other');
    await assert.rejects(f.local.execute('data_read', { plugin_id: 'other', generation: String(other.generation) },
      { source_id: 'state' }, f.lifetime.signal), code('target_not_selected'));
    await f.manager.unload('example');
    await assert.rejects(f.execute('data_read', { source_id: 'state' }));
    assert.doesNotThrow(() => register(definition));
  } finally { await f.close(); }
});

test('数据源源码与新增定向测试严格类型检查，不编译整仓', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const roots = [fileURLToPath(import.meta.url), fileURLToPath(new URL('./debugger-data.test.ts', import.meta.url))];
  const program = ts.createProgram(roots, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file &&
    (/\/debugger(?:-local)?\/|\/debugger-data[^/]*\.test\.ts$|\/plugin-sdk\/debug\.ts$/).test(diagnostic.file.fileName.replaceAll('\\', '/')));
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
});
