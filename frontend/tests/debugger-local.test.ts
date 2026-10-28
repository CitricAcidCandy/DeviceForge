import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { createLocalDebugger } from '../src/app/debugger-local/index.ts';
import type { LocalDebugger, LocalDebuggerOptions } from '../src/app/debugger-local/index.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DebugAccess, HostContext, JsonValue, WebPlugin } from '../src/plugin-sdk/index.ts';
import { object, json } from '../src/app/debugger-local/validation.ts';

function host(signal: AbortSignal): HostContext {
  return { apiVersion: 2, signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('不能触发设备或业务提交'); },
    getJob: async () => { throw new Error('不能读取业务任务'); },
    cancelJob: async () => { throw new Error('不能取消业务任务'); },
    subscribeOperations: () => () => {}, onDispose: () => () => {},
  };
}
function fixture(slots: NonNullable<LocalDebuggerOptions['slots']> = [
  { id: 'example.slot', label: '公开扩展槽', modes: ['append', 'replace'], route: null, description: '仅目录登记，不由DOM推断' },
], callbacks: Pick<LocalDebuggerOptions, 'readHostRoutes' | 'navigate' | 'reloadPlugin'> = {}) {
  const dom = new JSDOM('<main></main>', { url: 'https://example.invalid/' });
  const parent = dom.window.document.querySelector('main'); assert.ok(parent);
  const lifetime = new AbortController();
  const extensions = createExtensionRegistry();
  const debugAccess = new Map<string, DebugAccess>();
  let local: LocalDebugger | undefined;
  const manager = createPluginManager({ host: host(lifetime.signal), extensionRegistry: extensions,
    panelTarget: () => parent, componentTarget: () => parent,
    debugForPlugin(id, generation, scope) {
      assert.ok(local);
      const access = local.attach(id, String(generation), scope);
      debugAccess.set(id, access);
      return access;
    },
    observe: (event) => local?.observe(event),
  });
  local = createLocalDebugger({ document: dom.window.document, signal: lifetime.signal, manager: () => manager, extensions,
    slots, ...callbacks,
  });
  const debuggerLocal = local;
  const signal = new AbortController().signal;
  async function load(id = 'example', extra: Partial<WebPlugin> = {}) {
    const plugin: WebPlugin = { id, version: '1.2.3', apiVersion: 2,
      panels: [{ id: `${id}.main`, title: '主面板', mount: async (root) => {
        root.innerHTML = '<button type="button" data-deviceforge-action="local">本地动作</button>'; return () => {};
      } }, { id: `${id}.other`, title: '副面板', mount: async (root) => {
        root.innerHTML = '<p aria-label="另一挂载根">另一挂载根</p>'; return () => {};
      } }], ...extra };
    manager.register({ id, trusted: true, plugin });
    return manager.load(id);
  }
  const target = (id = 'example', generation: string | null = null) => ({ plugin_id: id, generation });
  const execute = (tool: string, parameters: JsonValue = {}, selected = target()) => debuggerLocal.execute(tool, selected, parameters, signal);
  return { dom, parent, lifetime, manager, extensions, debugAccess, local: debuggerLocal, load, target, execute, signal,
    async close() { debuggerLocal.dispose(); await manager.dispose(); extensions.dispose(); dom.window.close(); } };
}
function code(expected: string) {
  return (error: unknown) => error instanceof HostError && error.code === `debugger_${expected}`;
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map((entry: unknown) => object(entry));
}
function tree(value: JsonValue) { return object(object(value).tree); }

test('本地装配写集保持严格类型，不用断言绕过公共契约', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const source = fileURLToPath(new URL('../src/app/debugger-local/index.ts', import.meta.url));
  const program = ts.createProgram([source, fileURLToPath(import.meta.url)], parsed.options);
  const testPath = fileURLToPath(import.meta.url).replaceAll('\\', '/');
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file &&
    (diagnostic.file.fileName.replaceAll('\\', '/').includes('/app/debugger-local/') || diagnostic.file.fileName.replaceAll('\\', '/') === testPath));
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (path) => path, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  for (const file of program.getSourceFiles().filter((file) => file.fileName.replaceAll('\\', '/').includes('/app/debugger-local/'))) {
    function inspect(node: ts.Node) {
      assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, `${file.fileName}不能引入any`);
      assert.ok(!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node) && !ts.isNonNullExpression(node), `${file.fileName}不能用断言绕过接口`);
      ts.forEachChild(node, inspect);
    }
    inspect(file);
  }
});

test('只有明确选择的当前目标可执行；目录及无会话不扫描DOM或采事件', async () => {
  const f = fixture();
  try {
    const current = await f.load();
    await f.load('other');
    const access = f.debugAccess.get('example'); assert.ok(access);
    access.emit({ name: '无会话不留存' });
    let scans = 0;
    const query = f.dom.window.document.querySelectorAll.bind(f.dom.window.document);
    f.dom.window.document.querySelectorAll = (selector: string) => { scans++; return query(selector); };
    assert.equal(f.local.directory().length, 2);
    assert.equal(scans, 0);
    await assert.rejects(f.execute('inspect'), code('target_not_selected'));
    assert.equal(scans, 0);
    f.local.select([f.target('example', String(current.generation))]);
    access.emit({ name: '已选目标采集' });
    f.debugAccess.get('other')?.emit({ name: '未选目标不采集' });
    const result = object(await f.execute('inspect'));
    assert.deepEqual(records(object(result.debug).events).map((event) => event.name), ['已选目标采集']);
    await assert.rejects(f.execute('inspect', {}, f.target('other')), code('target_not_selected'));
    f.local.select([]);
    access.emit({ name: '停止会话不采集' });
    f.local.select([f.target()]);
    assert.deepEqual(object(object(await f.execute('inspect')).debug).events, []);
  } finally { await f.close(); }
});

test('未实例化不虚构树，多根缺省仅返回roots，显式选择不混入另一插件', async () => {
  const f = fixture();
  try {
    await f.load(); await f.load('other');
    f.local.select([f.target()]);
    assert.equal(object(await f.execute('ui_tree')).status, 'not_instantiated');
    await f.manager.mount('example', 'example.main');
    await f.manager.mount('example', 'example.other');
    await f.manager.mount('other', 'other.main');
    const ambiguous = object(await f.execute('ui_tree'));
    assert.equal(ambiguous.status, 'root_required'); assert.equal(ambiguous.tree, undefined);
    const roots = records(ambiguous.roots); assert.equal(roots.length, 2);
    assert.ok(roots.every((root) => typeof root.root_id === 'string'));
    const chosen = roots.find((root) => root.contribution_id === 'example.other'); assert.ok(chosen);
    const result = tree(await f.execute('ui_tree', { root_id: json(chosen.root_id) }));
    assert.ok(records(result.nodes).some((node) => node.name === '另一挂载根'));
    assert.ok(records(result.nodes).every((node) => node.name !== '本地动作'));
    await assert.rejects(f.execute('ui_tree', { root_id: 'root-not-owned' }), code('root_unavailable'));
    assert.equal(records(object(await f.execute('inspect')).slot_catalog)[0]?.instantiated, false);
  } finally { await f.close(); }
});

test('当前代次锁定，旧代目标与旧节点拒绝，select清除高亮和快照缓存', async () => {
  const f = fixture();
  try {
    const first = await f.load(); f.local.select([f.target()]);
    await f.manager.mount('example', 'example.main');
    const snapshot = tree(await f.execute('ui_tree'));
    const node = records(snapshot.nodes).find((entry) => entry.role === 'button'); assert.ok(node);
    const reference = { id: json(node.id), generation: json(node.generation), revision: json(node.revision) };
    assert.equal(object(await f.execute('ui_action', { action: { type: 'highlight', target: reference } })).status, 'applied');
    const button = f.parent.querySelector('button'); assert.ok(button);
    assert.equal(button.classList.contains('outline-2'), true);
    f.local.select([]);
    assert.equal(button.classList.contains('outline-2'), false);
    f.local.select([f.target()]);
    await assert.rejects(f.execute('ui_diff', { before_id: json(snapshot.id), after_id: json(snapshot.id) }), code('snapshot_unavailable'));
    await f.manager.unload('example');
    await f.manager.load('example');
    await assert.rejects(f.execute('inspect', {}, f.target('example', String(first.generation))), code('stale_generation'));
    await assert.rejects(f.execute('inspect'), code('target_not_selected'));
    f.local.select([f.target()]); await f.manager.mount('example', 'example.main');
    assert.equal(object(await f.execute('ui_action', { action: { type: 'click', target: reference, confirmed: true } })).status, 'rejected');
  } finally { await f.close(); }
});

test('ui_diff严格使用同一collector缓存，跨根及超出最近10项明确拒绝', async () => {
  const f = fixture();
  try {
    await f.load(); f.local.select([f.target()]); await f.manager.mount('example', 'example.main');
    const before = tree(await f.execute('ui_tree'));
    const paragraph = f.dom.window.document.createElement('p'); paragraph.textContent = '新增证据';
    f.parent.querySelector('[data-deviceforge-panel]')?.append(paragraph);
    const after = tree(await f.execute('ui_tree'));
    const diff = object(await f.execute('ui_diff', { before_id: json(before.id), after_id: json(after.id) }));
    assert.equal(diff.status, 'comparable'); assert.equal(records(diff.added).length, 1);
    await f.manager.mount('example', 'example.other');
    const roots = records(object(await f.execute('ui_tree')).roots);
    const first = roots.find((root) => root.contribution_id === 'example.main');
    const second = roots.find((root) => root.contribution_id === 'example.other'); assert.ok(first); assert.ok(second);
    const foreign = tree(await f.execute('ui_tree', { root_id: json(second.root_id) }));
    await assert.rejects(f.execute('ui_diff', { root_id: json(first.root_id), before_id: json(before.id), after_id: json(foreign.id) }), code('snapshot_unavailable'));
    for (let index = 0; index < 10; index++) await f.execute('ui_tree', { root_id: json(first.root_id) });
    await assert.rejects(f.execute('ui_diff', { root_id: json(first.root_id), before_id: json(before.id), after_id: json(after.id) }), code('snapshot_unavailable'));
  } finally { await f.close(); }
});

test('无会话轻量登记语义和资源，调试错误不影响业务，scope释放恰好一次', async () => {
  const f = fixture();
  let releases = 0;
  try {
    await f.load();
    const access = f.debugAccess.get('example'); assert.ok(access);
    access.registerNode({ id: 'example.node', role: 'status', label: '主动语义' });
    access.registerResource({ id: 'example.resource', kind: 'subscription', label: '业务订阅' }, () => { releases++; });
    const invalid = access.registerNode({ id: 'example.node', role: 'status', label: '重复登记' });
    assert.equal(invalid.generation, 0);
    assert.equal(f.manager.snapshot()[0]?.state, 'loaded');
    f.local.select([f.target()]);
    const result = object(await f.execute('inspect'));
    assert.equal(records(object(result.debug).nodes).length, 1);
    assert.equal(records(object(result.debug).resources).length, 1);
    assert.equal(result.registration_failures, 1);
    f.local.select([]); assert.equal(releases, 0);
    await f.manager.unload('example'); assert.equal(releases, 1);
    assert.doesNotThrow(() => access.emit({ name: '旧代事件' }));
    assert.doesNotThrow(() => invalid.update({ role: 'status', label: '无效句柄不影响业务' }));
    f.local.dispose(); assert.equal(releases, 1);
  } finally { await f.close(); }
});

test('真实资源释放失败导致卸载拒绝且旧代诊断保留，重复资源回收与新代隔离', async () => {
  const f = fixture();
  const failure = new Error('释放未确认');
  let failedReleases = 0, duplicateReleases = 0, nextReleases = 0;
  function containsFailure(error: unknown): boolean {
    return error === failure || error instanceof AggregateError && error.errors.some((nested: unknown) => containsFailure(nested));
  }
  try {
    const previous = await f.load(); f.local.select([f.target()]);
    const access = f.debugAccess.get('example'); assert.ok(access);
    const release = access.registerResource({ id: 'resource', kind: 'timer', label: '失败资源' }, () => { failedReleases++; throw failure; });
    await release();
    const snapshot = object(object(await f.execute('inspect')).debug);
    assert.equal(records(snapshot.resources)[0]?.state, 'release_failed');
    assert.equal(failedReleases, 1);
    access.registerResource({ id: 'resource', kind: 'timer', label: '重复资源' }, () => { duplicateReleases++; });
    await assert.rejects(f.manager.unload('example'), containsFailure);
    assert.equal(failedReleases, 1);
    assert.equal(duplicateReleases, 1);
    assert.equal(f.manager.cleanupSnapshot().length, 1);
    const oldDiagnostic = f.manager.cleanupSnapshot()[0]; assert.ok(oldDiagnostic);
    assert.equal(oldDiagnostic.id, 'example');
    assert.equal(oldDiagnostic.generation, previous.generation);
    assert.equal(containsFailure(oldDiagnostic.error), true);
    assert.equal(f.manager.snapshot().length, 0);

    const next = await f.manager.load('example');
    assert.notEqual(next.generation, previous.generation);
    assert.equal(next.state, 'loaded');
    assert.deepEqual(f.manager.cleanupSnapshot(), [oldDiagnostic]);
    f.local.select([f.target()]);
    const nextAccess = f.debugAccess.get('example'); assert.ok(nextAccess);
    assert.notEqual(nextAccess, access);
    nextAccess.registerResource({ id: 'resource', kind: 'timer', label: '新代资源' }, () => { nextReleases++; });
    const nextSnapshot = object(object(await f.execute('inspect')).debug);
    assert.equal(records(nextSnapshot.resources)[0]?.state, 'registered');
    await f.manager.unload('example');
    assert.equal(nextReleases, 1);
    assert.equal(failedReleases, 1);
    assert.equal(duplicateReleases, 1);
    assert.deepEqual(f.manager.cleanupSnapshot(), [oldDiagnostic]);
  } finally { await f.close(); }
});

test('容量有界：选择最多64、事件500、生命周期200、节点500、报告和树1MiB', async () => {
  const f = fixture();
  try {
    const current = await f.load();
    assert.throws(() => f.local.select(Array.from({ length: 65 }, () => f.target())), code('limit_exceeded'));
    f.local.select([f.target()]);
    const access = f.debugAccess.get('example'); assert.ok(access);
    for (let index = 0; index < 520; index++) {
      access.emit({ name: `事件${index}` });
      access.registerNode({ id: `node-${index}`, role: 'status', label: '有界登记' });
      f.local.observe({ pluginId: 'example', generation: current.generation, stage: 'loaded', at: index });
    }
    const inspected = object(await f.execute('inspect'));
    assert.equal(records(object(inspected.debug).events).length, 500);
    assert.equal(records(object(inspected.debug).nodes).length, 500);
    assert.equal(records(inspected.lifecycle).length, 200);
    assert.equal(inspected.registration_failures, 20);
    await f.manager.mount('example', 'example.main');
    const root = f.parent.querySelector('[data-deviceforge-panel]'); assert.ok(root);
    for (let index = 0; index < 600; index++) root.append(f.dom.window.document.createElement('p'));
    const result = tree(await f.execute('ui_tree'));
    assert.equal(records(result.nodes).length, 500);
    assert.ok(JSON.stringify(result).includes('nodes'));
    const report = await f.execute('report');
    assert.ok(new TextEncoder().encode(JSON.stringify(report)).byteLength <= 1024 * 1024);
    assert.throws(() => json({ text: '字'.repeat(400000) }), code('limit_exceeded'));
  } finally { await f.close(); }
});

test('未知参数、安全能力和未支持动作明确HostError，拒绝访问器且不求值', async () => {
  const f = fixture();
  try {
    await f.load(); f.local.select([f.target()]); await f.manager.mount('example', 'example.main');
    await assert.rejects(f.execute('eval', { script: 'globalThis.compromised=true' }), code('capability_unavailable'));
    await assert.rejects(f.execute('ui_tree', { unexpected: true }), code('invalid_parameters'));
    await assert.rejects(f.execute('ui_action', { action: { type: 'navigate', path: '/devices', confirmed: true } }), code('capability_unavailable'));
    await assert.rejects(f.execute('ui_query', { query: { limit: '500' } }), code('invalid_parameters'));
    await assert.rejects(f.execute('ui_assert', { assertion: { query: {}, condition: 'count', expected: -1 } }), code('invalid_parameters'));
    let reads = 0;
    const unknown: unknown = Object.defineProperty({}, 'danger', { enumerable: true, get() { reads++; return '不能读取'; } });
    assert.throws(() => json(unknown), code('invalid_parameters')); assert.equal(reads, 0);
    assert.throws(() => f.local.select([{ plugin_id: 'example', generation: '01' }]), code('invalid_parameters'));
    f.local.dispose();
    await assert.rejects(f.execute('inspect'), code('disposed'));
  } finally { await f.close(); }
});

test('invoke验证当前归属与版本，默认只返回元数据，显式请求才返回脱敏HostResult', async () => {
  const f = fixture();
  let calls = 0;
  const result = async () => { calls++; return { data: { token: '敏感令牌', nested: { password: '密码', ok: '结果' } }, logId: 'public-log-id' }; };
  try {
    await f.load('example', { contributions: {
      commands: [{ id: 'example.command', title: '示例命令', execute: result }],
      services: [{ id: 'example.service', version: '1.0.0', invoke: result }],
    } });
    await f.load('other', { contributions: { commands: [{ id: 'other.command', title: '其他命令', execute: result }] } });
    f.local.select([f.target()]);
    const catalog = object(object(await f.execute('inspect')).catalog);
    assert.equal(records(catalog.commands)[0]?.schema_status, 'missing');
    assert.equal(records(catalog.services)[0]?.schema_status, 'unconstrained_or_missing');
    const confirmation = { confirmed: true, allow_unknown_side_effects: true };
    await assert.rejects(f.execute('invoke', { kind: 'command', id: 'example.command', input: {} }), code('confirmation_required'));
    await assert.rejects(f.execute('invoke', { kind: 'command', id: 'other.command', input: {}, ...confirmation }), code('target_mismatch'));
    await assert.rejects(f.execute('invoke', { kind: 'service', id: 'example.service', version: '^1.0.0', input: {}, ...confirmation }), code('target_mismatch'));
    assert.equal(calls, 0);
    const reply = await f.execute('invoke', { kind: 'service', id: 'example.service', version: '1.0.0', input: {}, ...confirmation });
    assert.equal(object(reply).data, null);
    assert.equal(object(object(reply).result_metadata).included, false);
    assert.ok(!JSON.stringify(reply).includes('敏感令牌'));
    assert.equal(object(reply).logId, 'public-log-id');
    assert.equal(calls, 1);
    const included = await f.execute('invoke', { kind: 'service', id: 'example.service', version: '1.0.0', input: {},
      include_result: true, ...confirmation });
    assert.deepEqual(included, { data: { token: '[已脱敏]', nested: { password: '[已脱敏]', ok: '结果' } }, logId: 'public-log-id' });
    await f.manager.unload('example'); await f.manager.load('example');
    await assert.rejects(f.execute('invoke', { kind: 'command', id: 'example.command', input: {}, ...confirmation }), code('target_not_selected'));
    assert.equal(calls, 2);
  } finally { await f.close(); }
});

test('invoke取消结果未确认不重放，选择变化撤销动作等待和在途结果', async () => {
  const f = fixture();
  let calls = 0;
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    await f.load('example', { contributions: { commands: [{ id: 'example.pending', title: '不会返回', execute: async () => {
      calls++; entered(); return new Promise(() => {});
    } }] } });
    f.local.select([f.target()]);
    const controller = new AbortController();
    const pending = f.local.execute('invoke', f.target(), { kind: 'command', id: 'example.pending', input: {}, confirmed: true,
      allow_unknown_side_effects: true }, controller.signal);
    await started; controller.abort();
    await assert.rejects(pending, code('result_unconfirmed'));
    assert.equal(calls, 1);
    await f.manager.mount('example', 'example.main');
    const waiting = f.execute('ui_action', { action: { type: 'wait', assertion: { query: { name: '不存在' }, condition: 'exists' }, timeoutMs: 10000 } });
    f.local.select([]);
    await assert.rejects(waiting);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('reload只重载浏览器当前实例，不安装release；卸载失败不继续load', async () => {
  const f = fixture();
  try {
    const first = await f.load(); f.local.select([f.target()]); await f.manager.mount('example', 'example.main');
    await assert.rejects(f.execute('reload'), code('confirmation_required'));
    const reply = object(await f.execute('reload', { confirmed: true }));
    assert.equal(reply.scope, 'browser-runtime-only'); assert.equal(reply.installation_changed, false);
    assert.notEqual(reply.generation, String(first.generation)); assert.equal(f.parent.childElementCount, 0);
    await assert.rejects(f.execute('inspect'), code('target_not_selected'));
    f.local.select([f.target()]);
    const reloadUnload = f.manager.unload;
    const reloadLoad = f.manager.load;
    let loads = 0;
    f.manager.unload = async () => { throw new Error('卸载结果未确认'); };
    f.manager.load = async (id) => { loads++; return reloadLoad(id); };
    await assert.rejects(f.execute('reload', { confirmed: true }), /卸载结果未确认/);
    assert.equal(loads, 0);
    f.manager.unload = reloadUnload;
    f.manager.load = reloadLoad;
  } finally { await f.close(); }
});

test('宿主关闭回收动作、高亮与调试资源且幂等，不关闭业务管理器', async () => {
  const f = fixture();
  let releases = 0;
  try {
    await f.load(); f.local.select([f.target()]); await f.manager.mount('example', 'example.main');
    f.debugAccess.get('example')?.registerResource({ id: 'resource', kind: 'timer', label: '可释放' }, () => { releases++; });
    const snapshot = tree(await f.execute('ui_tree'));
    const node = records(snapshot.nodes).find((item) => item.role === 'button'); assert.ok(node);
    await f.execute('ui_action', { action: { type: 'highlight', target: { id: json(node.id), generation: json(node.generation), revision: json(node.revision) } } });
    f.local.dispose(); f.local.dispose();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(releases, 1);
    assert.equal(f.parent.querySelector('button')?.classList.contains('outline-2'), false);
    assert.equal(f.manager.snapshot()[0]?.state, 'loaded');
    await assert.rejects(f.execute('report'), code('disposed'));
  } finally { await f.close(); }
});

test('公开槽位区分宿主实例化与目标扩展挂载', async () => {
  const f = fixture();
  try {
    await f.load('example', { contributions: { components: [{ id: 'example.component', title: '公开组件',
      slot: 'example.slot', mode: 'append', mount: async (root) => { root.textContent = '真实扩展'; return () => {}; },
    }] } });
    f.local.select([f.target()]);
    const before = records(object(await f.execute('inspect')).slot_catalog)[0]; assert.ok(before);
    assert.equal(before.id, 'example.slot'); assert.equal(before.instantiated, false);
    assert.equal(before.mounted_by_target, false);
    assert.deepEqual(before.modes, ['append', 'replace']);
    f.parent.setAttribute('data-deviceforge-slot', 'example.slot');
    await f.manager.mountComponent('example.component');
    const after = records(object(await f.execute('inspect')).slot_catalog)[0]; assert.ok(after);
    assert.equal(after.instantiated, true);
    assert.equal(after.mounted_by_target, true);
    const snapshot = tree(await f.execute('ui_tree'));
    assert.equal(records(snapshot.nodes)[0]?.kind, 'surface');
    assert.ok(records(snapshot.nodes).every((node) => node.kind !== 'slot'));
    await f.manager.unmountExtension('example.component');
    const unmounted = records(object(await f.execute('inspect')).slot_catalog)[0]; assert.ok(unmounted);
    assert.equal(unmounted.instantiated, true);
    assert.equal(unmounted.mounted_by_target, false);
    f.parent.removeAttribute('data-deviceforge-slot');
    assert.equal(records(object(await f.execute('inspect')).slot_catalog)[0]?.instantiated, false);
  } finally { await f.close(); }
});

test('宿主槽存在但目标无贡献', async () => {
  const f = fixture([{ id: 'devices.apps', label: '设备应用面', modes: ['append', 'replace'], route: 'devices', description: '宿主公开应用槽' }]);
  try {
    await f.load(); f.local.select([f.target()]);
    const ordinary = f.dom.window.document.createElement('div');
    ordinary.id = 'devices.apps'; ordinary.innerHTML = '<div role="row">普通宿主行，不是公开槽位</div>';
    f.parent.append(ordinary);
    const inspect = async () => {
      const catalog = records(object(await f.execute('inspect')).slot_catalog);
      assert.deepEqual(catalog.map((slot) => slot.id), ['devices.apps']);
      const slot = catalog[0]; assert.ok(slot);
      assert.equal(slot.mounted_by_target, false);
      assert.deepEqual(slot.evidence, { instantiated: 'host-public-slot-or-surface-anchor', mounted_by_target: 'selected-plugin-mounted-contributions' });
      return slot;
    };
    assert.equal((await inspect()).instantiated, false);
    const unknown = f.dom.window.document.createElement('div');
    unknown.setAttribute('data-deviceforge-slot', 'devices.apps.row'); f.parent.append(unknown);
    for (const attribute of ['data-deviceforge-slot', 'data-deviceforge-surface']) {
      const anchor = f.dom.window.document.createElement('div');
      anchor.setAttribute(attribute, 'devices.apps'); anchor.append(ordinary);
      anchor.querySelectorAll = () => { throw new Error('不得扫描公开锚点的后代'); };
      f.parent.append(anchor);
      assert.equal((await inspect()).instantiated, true);
      anchor.remove();
      assert.equal((await inspect()).instantiated, false);
    }
  } finally { await f.close(); }
});

test('invoke拒绝目录中同插件但非当前generation的贡献', async () => {
  const f = fixture();
  let calls = 0;
  try {
    const current = await f.load(); f.local.select([f.target()]);
    const release = f.extensions.register({ pluginId: 'example', generation: current.generation + 1,
      context: host(f.lifetime.signal) }, { commands: [{ id: 'example.wrong-generation', title: '另一代贡献',
      execute: async () => { calls++; return { data: null, logId: null }; },
    }] });
    try {
      await assert.rejects(f.execute('invoke', { kind: 'command', id: 'example.wrong-generation', input: {},
        confirmed: true, allow_unknown_side_effects: true }), code('target_mismatch'));
      assert.equal(calls, 0);
    } finally { await release(); }
  } finally { await f.close(); }
});

test('最多4项在途，取消不会自动重放第五项', async () => {
  const f = fixture();
  let calls = 0;
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  try {
    await f.load('example', { contributions: { commands: [{ id: 'example.pending', title: '在途请求', execute: async () => {
      if (++calls === 4) entered(); return new Promise(() => {});
    } }] } });
    f.local.select([f.target()]);
    const input = { kind: 'command', id: 'example.pending', input: null, confirmed: true, allow_unknown_side_effects: true };
    const pending = Array.from({ length: 4 }, () => f.local.execute('invoke', f.target(), input, f.signal));
    const settled = Promise.allSettled(pending);
    await ready;
    await assert.rejects(f.execute('invoke', input), code('limit_exceeded'));
    assert.equal(calls, 4);
    f.local.select([]);
    assert.ok((await settled).every((result) => result.status === 'rejected'));
    assert.equal(calls, 4);
  } finally { await f.close(); }
});

test('UI collector总数有界，移除目标会话回收容量', async () => {
  const f = fixture();
  try {
    await f.load(); f.local.select([f.target()]);
    const mounted = await f.manager.load('example');
    for (let index = 0; index < 17; index++) {
      const root = f.dom.window.document.createElement('div');
      root.dataset.deviceforgePlugin = 'example'; root.dataset.deviceforgeGeneration = String(mounted.generation);
      root.dataset.deviceforgePanel = `example.external-${index}`; f.parent.append(root);
    }
    const roots = records(object(await f.execute('ui_tree')).roots);
    for (const root of roots.slice(0, 16)) await f.execute('ui_tree', { root_id: json(root.root_id) });
    const last = roots.at(-1); assert.ok(last);
    await assert.rejects(f.execute('ui_tree', { root_id: json(last.root_id) }), code('limit_exceeded'));
    f.local.select([]); f.local.select([f.target()]);
    assert.ok(tree(await f.execute('ui_tree', { root_id: json(last.root_id) })).id);
  } finally { await f.close(); }
});

test('旧代attach不能覆盖新代登记或释放新代业务资源', async () => {
  const f = fixture();
  const scope = createPluginScope(host(f.lifetime.signal));
  let releases = 0;
  try {
    const previous = await f.load(); await f.manager.unload('example'); await f.manager.load('example');
    const access = f.debugAccess.get('example'); assert.ok(access);
    access.registerResource({ id: 'new.resource', kind: 'subscription', label: '新代业务资源' }, () => { releases++; });
    assert.throws(() => f.local.attach('example', String(previous.generation), scope), code('stale_generation'));
    assert.equal(releases, 0);
    f.local.select([f.target()]);
    assert.equal(records(object(object(await f.execute('inspect')).debug).resources).length, 1);
  } finally { await scope.dispose(); await f.close(); }
});

test('reload等待撤销后即使原卸载晚到，也不自动load或重放', async () => {
  const f = fixture();
  let loads = 0;
  let finish: () => void = () => {};
  let enter: () => void = () => {};
  const started = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const originalUnload = f.manager.unload;
  const originalLoad = f.manager.load;
  try {
    await f.load(); f.local.select([f.target()]);
    f.manager.unload = async (id) => { enter(); await gate; await originalUnload(id); };
    f.manager.load = async (id) => { loads++; return originalLoad(id); };
    const controller = new AbortController();
    const pending = f.local.execute('reload', f.target(), { confirmed: true }, controller.signal);
    await started; controller.abort();
    await assert.rejects(pending, code('result_unconfirmed'));
    finish();
    await f.manager.unload('example');
    assert.equal(loads, 0);
    assert.equal(f.manager.snapshot().length, 0);
  } finally { finish(); f.manager.unload = originalUnload; f.manager.load = originalLoad; await f.close(); }
});

test('公开概览包含全部槽位和未实例化路由及挂载；面板不冒充插槽', async () => {
  const f = fixture(undefined, { readHostRoutes: () => [{ path: '/devices', label: '设备', slotIds: ['example.slot'] },
    { path: '/never-opened', label: '尚未打开' }] });
  try {
    await f.load('example', { contributions: { components: [{ id: 'example.component', title: '组件', slot: 'example.slot', mode: 'append', mount: async () => () => {} }],
      modules: [{ id: 'example.route', title: '插件模块', route: '/extra', mount: async () => () => {} }] } });
    f.local.select([f.target()]);
    const overview = object(await f.execute('ui_tree', { view: 'overview', limit: 2 }));
    assert.equal(overview.source, 'host-public-catalog'); assert.equal(overview.completeness, 'catalog-only');
    assert.equal(records(overview.nodes).length, 2); assert.equal(object(overview.page).nextOffset, 2);
    const all = records(object(await f.execute('ui_tree', { view: 'overview' })).nodes);
    assert.ok(all.some((node) => node.kind === 'route' && object(node.catalog).path === '/never-opened'));
    const inspected = object(await f.execute('inspect'));
    assert.deepEqual(records(inspected.slot_catalog).map((slot) => slot.id), ['example.slot']);
    const mounts = records(inspected.mount_catalog);
    assert.equal(mounts.length, 4); assert.ok(mounts.every((mount) => mount.mounted === false));
    assert.ok(mounts.filter((mount) => mount.kind === 'panel').every((mount) => mount.slot_id === null));
    assert.equal(mounts.find((mount) => mount.kind === 'component')?.slot_id, 'example.slot');
    await f.manager.mount('example', 'example.main');
    assert.equal(records(object(await f.execute('inspect')).mount_catalog).find((mount) => mount.id === 'example.main')?.mounted, true);
    assert.equal(records(object(await f.execute('inspect')).slot_catalog)[0]?.mounted_by_target, false);
  } finally { await f.close(); }
});

test('无挂载根时通过精确公开路由回调导航，非白名单和取消不能重放', async () => {
  let calls = 0;
  const f = fixture(undefined, { readHostRoutes: () => [{ path: '/devices', label: '设备' }],
    navigate: (path, signal) => { assert.equal(path, '/devices'); signal.throwIfAborted(); calls++; } });
  try {
    await f.load(); f.local.select([f.target()]);
    assert.equal(object(object(await f.execute('inspect')).capabilities).navigate, true);
    const reply = object(await f.execute('ui_action', { action: { type: 'navigate', path: '/devices', confirmed: true } }));
    assert.equal(reply.status, 'dispatched'); assert.equal(calls, 1);
    await assert.rejects(f.execute('ui_action', { action: { type: 'navigate', path: '/devices?token=x', confirmed: true } }), code('capability_unavailable'));
    await assert.rejects(f.execute('ui_action', { root_id: 'irrelevant', action: { type: 'navigate', path: '/devices', confirmed: true } }), code('invalid_parameters'));
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('公共拾取排除自身子树，拦截其他插件但只返回明确owner，不自动开启其调试', async () => {
  const f = fixture();
  try {
    await f.load(); const other = await f.load('other'); f.local.select([f.target()]);
    await f.manager.mount('example', 'example.main'); await f.manager.mount('other', 'other.main');
    const internal = f.dom.window.document.createElement('button');
    internal.setAttribute('data-deviceforge-debugger-internal', ''); f.parent.append(internal);
    let internalClicks = 0; internal.addEventListener('click', () => { internalClicks++; });
    const foreign = f.parent.querySelector('[data-deviceforge-plugin="other"] button'); assert.ok(foreign);
    let foreignClicks = 0; foreign.addEventListener('click', () => { foreignClicks++; });
    const pending = f.execute('ui_action', { action: { type: 'pick' } });
    internal.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    foreign.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const result = object(await pending);
    assert.equal(result.status, 'indeterminate'); assert.deepEqual(result.owner, { pluginId: 'other', generation: other.generation });
    assert.equal(result.target, null); assert.equal(foreignClicks, 0); assert.equal(internalClicks, 1);
    await assert.rejects(f.execute('inspect', {}, f.target('other')), code('target_not_selected'));
    const button = f.parent.querySelector('[data-deviceforge-plugin="example"] button'); assert.ok(button);
    let clicks = 0; button.addEventListener('click', () => { clicks++; });
    const selected = f.execute('ui_action', { action: { type: 'pick' } });
    button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const chosen = object(await selected);
    assert.equal(chosen.status, 'picked'); assert.equal(typeof chosen.root_id, 'string'); assert.ok(chosen.target); assert.equal(clicks, 0);
    const cancel = new AbortController();
    const cancelled = f.local.execute('ui_action', f.target(), { action: { type: 'pick' } }, cancel.signal); cancel.abort();
    await assert.rejects(cancelled);
    button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(clicks, 1);
  } finally { await f.close(); }
});

test('DOM冻结翻页和报告携带完整快照页，报告只导出已采证据，卸载拒绝旧页', async () => {
  const f = fixture();
  try {
    await f.load(); f.local.select([f.target()]); await f.manager.mount('example', 'example.main');
    assert.deepEqual(object(await f.execute('report')).cached_trees, []);
    const root = f.parent.querySelector('[data-deviceforge-panel]'); assert.ok(root);
    for (let index = 0; index < 580; index++) {
      const node = f.dom.window.document.createElement('p'); node.setAttribute('aria-label', `节点${index}`); root.append(node);
    }
    const firstResult = object(await f.execute('ui_tree')); const first = object(firstResult.tree);
    assert.equal(object(first.page).nextOffset, 500);
    root.lastElementChild?.setAttribute('aria-label', '采集后的标签');
    const next = tree(await f.execute('ui_tree', { snapshot_id: json(first.id), offset: 500 }));
    assert.equal(records(next.nodes).at(-1)?.name, '节点579');
    await assert.rejects(f.execute('ui_tree', { offset: 500 }), code('invalid_parameters'));
    const report = object(await f.execute('report'));
    assert.equal(records(report.snapshot_manifest).length, 1);
    assert.equal(records(records(report.cached_trees)[0]?.snapshots).flatMap((page) => records(page.nodes)).length, 582);
    const reportPage = object(await f.execute('report', { root_id: json(firstResult.root_id), snapshot_id: json(first.id), offset: 500 }));
    assert.deepEqual(object(reportPage.tree).nodes, next.nodes);
    await f.manager.unmount('example', 'example.main');
    await assert.rejects(f.execute('report', { root_id: json(firstResult.root_id), snapshot_id: json(first.id) }), code('snapshot_unavailable'));
    assert.deepEqual(object(await f.execute('report')).cached_trees, []);
  } finally { await f.close(); }
});

test('动作和试调用关联事件只进入所选目标，保存日志ID而不保存调用内容', async () => {
  const f = fixture();
  try {
    await f.load('example', { contributions: { commands: [{ id: 'example.log', title: '日志关联',
      execute: async () => ({ data: { arbitrary: '输出哨兵' }, logId: 'log-public' }) }] } });
    await f.load('other'); f.local.select([f.target(), f.target('other')]);
    await f.execute('invoke', { kind: 'command', id: 'example.log', input: { text: '输入哨兵' },
      confirmed: true, allow_unknown_side_effects: true });
    const events = records(object(object(await f.execute('inspect')).debug).events);
    const associated = events.find((event) => event.name === 'debugger.invoke'); assert.ok(associated);
    assert.equal(object(associated.metadata).log_id, 'log-public');
    assert.ok(!JSON.stringify(events).includes('输入哨兵')); assert.ok(!JSON.stringify(events).includes('输出哨兵'));
    assert.deepEqual(object(object(await f.execute('inspect', {}, f.target('other'))).debug).events, []);
  } finally { await f.close(); }
});

test('共同安装重载钩子只委托一次，先校验确认和代次，不重复卸载或加载旧入口', async () => {
  let calls = 0, unloads = 0, loads = 0;
  let replace: () => Promise<number> = async () => { throw new Error('夹具尚未初始化'); };
  const f = fixture(undefined, { reloadPlugin: async (target, signal) => {
    assert.equal(target.plugin_id, 'example'); assert.ok(target.generation); signal.throwIfAborted(); calls++;
    const generation = await replace();
    return { status: 'loaded', plugin_id: target.plugin_id, generation: String(generation), scope: 'feature-browser-components',
      revision: 'new-revision', installation_changed: true };
  } });
  const originalUnload = f.manager.unload, originalLoad = f.manager.load;
  try {
    const current = await f.load(); f.local.select([f.target()]);
    replace = async () => {
      await originalUnload('example');
      // 模拟心跳先撤销旧选择，不能取消已经交付的重载等待。
      f.local.select([]);
      return (await originalLoad('example')).generation;
    };
    f.manager.unload = async () => { unloads++; throw new Error('钩子已负责卸载，本地不能重复'); };
    f.manager.load = async () => { loads++; throw new Error('不能沿旧运行源加载'); };
    await assert.rejects(f.execute('reload'), code('confirmation_required'));
    await assert.rejects(f.execute('reload', { confirmed: true }, f.target('example', String(current.generation + 1))), code('stale_generation'));
    assert.equal(calls, 0);
    const result = object(await f.execute('reload', { confirmed: true }));
    assert.equal(result.scope, 'feature-browser-components'); assert.equal(result.revision, 'new-revision');
    assert.equal(calls, 1); assert.equal(unloads, 0); assert.equal(loads, 0);
  } finally { f.manager.unload = originalUnload; f.manager.load = originalLoad; await f.close(); }
});

test('共同安装重载回执仍指向旧运行代次时明确未确认', async () => {
  const f = fixture(undefined, { reloadPlugin: async (target) => ({ status: 'loaded', ...target, scope: 'browser-runtime-only' }) });
  try {
    await f.load(); f.local.select([f.target()]);
    await assert.rejects(f.execute('reload', { confirmed: true }), code('result_unconfirmed'));
  } finally { await f.close(); }
});

test('共同安装重载钩子不返回时等待可取消，不重放回调', async () => {
  let calls = 0;
  let enter: () => void = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const f = fixture(undefined, { reloadPlugin: async () => { calls++; enter(); return new Promise(() => {}); } });
  try {
    await f.load(); f.local.select([f.target()]);
    const controller = new AbortController();
    const pending = f.local.execute('reload', f.target(), { confirmed: true }, controller.signal);
    await entered; controller.abort();
    await assert.rejects(pending, code('result_unconfirmed')); assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('本地默认原子试调用元数据不复制大返回值到调试响应', async () => {
  const f = fixture();
  const data = { large: '私密哨兵'.repeat(300000) };
  try {
    await f.load('example', { contributions: { commands: [{ id: 'example.large', title: '大原子结果',
      execute: async () => ({ data, logId: 'metadata-log' }) }] } });
    f.local.select([f.target()]);
    const result = object(await f.execute('invoke', { kind: 'command', id: 'example.large', input: null,
      confirmed: true, allow_unknown_side_effects: true }));
    assert.equal(result.data, null); assert.equal(result.logId, 'metadata-log');
    assert.equal(object(result.result_metadata).type, 'object');
    assert.ok(!JSON.stringify(result).includes('私密哨兵'));
  } finally { await f.close(); }
});

test('报告实际快照超过响应预算时明确续页且可完整读取冻结证据', async () => {
  const f = fixture();
  try {
    await f.load(); f.local.select([f.target()]); await f.manager.mount('example', 'example.main');
    const root = f.parent.querySelector('[data-deviceforge-panel]'); assert.ok(root);
    for (let index = 0; index < 498; index++) {
      const node = f.dom.window.document.createElement('p'); node.setAttribute('aria-label', '中'.repeat(256)); root.append(node);
    }
    for (let index = 0; index < 3; index++) await f.execute('ui_tree');
    const report = object(await f.execute('report'));
    assert.ok(new TextEncoder().encode(JSON.stringify(report)).byteLength <= 1024 * 1024);
    const continuation = object(report.continuation);
    assert.equal(typeof continuation.snapshot_id, 'string');
    const page = object(await f.execute('report', json(continuation)));
    assert.equal(records(object(page.tree).nodes).length, 500);
    assert.ok(new TextEncoder().encode(JSON.stringify(page)).byteLength <= 1024 * 1024);
  } finally { await f.close(); }
});

test('重载钩子跨过10秒仍等待，30秒总预算到期撤销且不重放', async (context) => {
  let calls = 0;
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let hookSignal: AbortSignal | undefined;
  const f = fixture(undefined, { reloadPlugin: async (_target, signal) => {
    calls++; hookSignal = signal; entered(); return new Promise(() => {});
  } });
  try {
    await f.load(); f.local.select([f.target()]);
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    // Node原生AbortSignal计时不受模拟时钟控制，接入同一时钟验证传入钩子的取消。
    context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), milliseconds); return controller.signal;
    });
    const pending = f.execute('reload', { confirmed: true });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, code('result_unconfirmed'));
    await ready;
    context.mock.timers.tick(10000); await Promise.resolve();
    assert.equal(settled, false); assert.equal(hookSignal?.aborted, false);
    context.mock.timers.tick(19999); await Promise.resolve(); assert.equal(settled, false);
    context.mock.timers.tick(1); await rejected;
    assert.equal(hookSignal?.aborted, true); assert.equal(calls, 1);
  } finally { context.mock.restoreAll(); context.mock.timers.reset(); await f.close(); }
});

test('运行实例重载的卸载和加载共享30秒总预算，不为加载重新计时', async (context) => {
  const f = fixture();
  let finishUnload: () => void = () => {}, finishLoad: () => void = () => {};
  let enterUnload: () => void = () => {}, enterLoad: () => void = () => {};
  const unloading = new Promise<void>((resolve) => { finishUnload = resolve; });
  const loading = new Promise<void>((resolve) => { finishLoad = resolve; });
  const unloadEntered = new Promise<void>((resolve) => { enterUnload = resolve; });
  const loadEntered = new Promise<void>((resolve) => { enterLoad = resolve; });
  const originalUnload = f.manager.unload, originalLoad = f.manager.load;
  let loads = 0;
  try {
    await f.load(); f.local.select([f.target()]);
    f.manager.unload = async (id) => { enterUnload(); await unloading; await originalUnload(id); };
    f.manager.load = async (id) => { loads++; const result = await originalLoad(id); enterLoad(); await loading; return result; };
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const pending = f.execute('reload', { confirmed: true });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, code('result_unconfirmed'));
    await unloadEntered;
    context.mock.timers.tick(20000); await Promise.resolve(); assert.equal(settled, false);
    finishUnload(); await loadEntered;
    context.mock.timers.tick(9999); await Promise.resolve(); assert.equal(settled, false);
    context.mock.timers.tick(1); await rejected;
    assert.equal(loads, 1);
  } finally {
    finishUnload(); finishLoad(); context.mock.timers.reset();
    f.manager.unload = originalUnload; f.manager.load = originalLoad; await f.close();
  }
});

test('重载预算调整后试调用仍在10秒结束等待且不重放', async (context) => {
  const f = fixture();
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  try {
    await f.load('example', { contributions: { commands: [{ id: 'example.timeout', title: '试调用期限', execute: async () => {
      calls++; entered(); return new Promise(() => {});
    } }] } });
    f.local.select([f.target()]);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = f.execute('invoke', { kind: 'command', id: 'example.timeout', input: null,
      confirmed: true, allow_unknown_side_effects: true });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, code('result_unconfirmed'));
    await ready;
    context.mock.timers.tick(9999); await Promise.resolve(); assert.equal(settled, false);
    context.mock.timers.tick(1); await rejected; assert.equal(calls, 1);
  } finally { context.mock.timers.reset(); await f.close(); }
});

test('宿主普通按钮拾取返回只读结构身份并拦截业务点击，自身调试子树不拾取', async () => {
  const f = fixture(undefined, { readHostRoutes: () => [{ path: '/devices', label: '设备' }] });
  try {
    await f.load(); f.local.select([f.target()]);
    f.dom.window.location.hash = '/devices';
    const ordinary = f.dom.window.document.createElement('button'); ordinary.textContent = '宿主业务';
    // 与公开槽同名的普通ID或未公开锚点不能形成真实插槽。
    ordinary.id = 'example.slot'; ordinary.setAttribute('data-deviceforge-slot', 'unpublished.slot'); f.parent.append(ordinary);
    const internalRoot = f.dom.window.document.createElement('div'); internalRoot.setAttribute('data-deviceforge-debugger-internal', '');
    const internalButton = f.dom.window.document.createElement('button'); internalRoot.append(internalButton); f.parent.append(internalRoot);
    let businessClicks = 0, debuggerClicks = 0;
    ordinary.addEventListener('click', () => { businessClicks++; });
    internalButton.addEventListener('click', () => { debuggerClicks++; });
    const picking = f.execute('ui_action', { action: { type: 'pick' } });
    internalButton.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const event = new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    assert.equal(ordinary.dispatchEvent(event), false);
    const picked = object(await picking);
    assert.equal(businessClicks, 0); assert.equal(debuggerClicks, 1);
    assert.equal(picked.status, 'picked'); assert.equal(picked.source, 'host-dom');
    assert.equal(picked.owner, null); assert.equal(picked.target, null); assert.equal(picked.root_id, null);
    assert.deepEqual(picked.host, { tag: 'button', role: 'button', label: '宿主业务', route: '/devices', insertable: false });
    assert.ok(String(picked.reason).includes('不能插入插件'));
    assert.deepEqual(object(object(await f.execute('inspect')).debug).nodes, []);
    assert.deepEqual(object(await f.execute('report')).cached_trees, []);
    ordinary.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(businessClicks, 1);
  } finally { await f.close(); }
});

test('宿主拾取只关联真实公开祖先槽位并脱敏敏感输入，不全宿主扫描', async () => {
  const f = fixture();
  try {
    await f.load(); f.local.select([f.target()]);
    const anchor = f.dom.window.document.createElement('section'); anchor.setAttribute('data-deviceforge-surface', 'example.slot');
    const input = f.dom.window.document.createElement('input'); input.name = 'api_key'; input.setAttribute('aria-label', 'token=敏感哨兵');
    Object.defineProperty(input, 'value', { get() { throw new Error('禁止读取宿主输入值'); } });
    anchor.append(input); f.parent.append(anchor);
    const scan = f.dom.window.document.querySelectorAll.bind(f.dom.window.document);
    f.dom.window.document.querySelectorAll = (selector: string) => {
      assert.ok(selector.includes('data-deviceforge-plugin')); return scan(selector);
    };
    const pending = f.execute('ui_action', { action: { type: 'pick' } });
    input.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const result = object(await pending);
    assert.deepEqual(result.host, { tag: 'input', role: 'textbox', label: '', nearest_slot: 'example.slot', insertable: false });
    assert.ok(!JSON.stringify(result).includes('敏感哨兵'));
  } finally { await f.close(); }
});
