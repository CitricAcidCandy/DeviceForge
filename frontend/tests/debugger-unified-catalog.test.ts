import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { HostError } from '../src/plugin-sdk/index.ts';
import { isJsonValue } from '../src/plugin-sdk/json.ts';
import type { DataSourceDefinition, Dispose, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { createLocalDebugger } from '../src/app/debugger-local/index.ts';
import type { LocalDebugger } from '../src/app/debugger-local/index.ts';

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function array(value: unknown): readonly unknown[] { assert.ok(Array.isArray(value)); return value; }
function revisionOf(snapshot: Record<string, unknown>): string {
  const revision = snapshot.revision;
  assert.ok(typeof revision === 'string');
  return revision;
}
function host(signal: AbortSignal): HostContext {
  return { apiVersion: 2, signal, listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('测试不提交设备操作'); }, getJob: async () => { throw new Error('测试不查询任务'); },
    cancelJob: async () => { throw new Error('测试不取消任务'); }, subscribeOperations: () => () => {}, onDispose: () => () => {} };
}
function code(expected: string, logId?: string) {
  return (error: unknown) => error instanceof HostError && error.code === expected && (logId === undefined || error.logId === logId);
}
async function fixture(options: { schema?: JsonValue; persistence?: 'memory' | 'persistent'; longIdentity?: boolean } = {}) {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main'); assert.ok(root);
  const lifetime = new AbortController();
  const extensions = createExtensionRegistry();
  const contexts = new Map<string, HostContext>();
  const releases = new Map<string, Dispose>();
  const definitions = new Map<string, DataSourceDefinition>();
  const calls: string[] = [];
  let value: JsonValue = { name: '原名', fixed: 1 };
  let revision = options.longIdentity ? 'r'.repeat(1024) : 'r1';
  let mode: 'normal' | 'conflict' | 'unknown' | 'hang' = 'normal';
  let local: LocalDebugger | undefined;
  const manager = createPluginManager({ host: host(lifetime.signal), extensionRegistry: extensions, panelTarget: () => root,
    debugForPlugin(id, generation, scope) {
      assert.ok(local);
      return local.attach(id, String(generation), scope);
    } });
  local = createLocalDebugger({ document: dom.window.document, signal: lifetime.signal, manager: () => manager, extensions });
  const debuggerLocal = local;
  async function load(id: string) {
    manager.register({ id, trusted: true, plugin: { id, version: '1', apiVersion: 2, panels: [],
      contributions: { services: [
        { id: `${id}.read`, version: '1', invoke: async () => {
          calls.push(`${id}.read`); return { data: { value, revision }, logId: `${id}-read-log` };
        } },
        { id: `${id}.write`, version: '1', invoke: async input => {
          calls.push(`${id}.write`);
          if (mode === 'conflict') throw new HostError('http', 'revision_conflict', '已有其他编辑', 'conflict-log', 409);
          if (mode === 'unknown') throw new HostError('network', 'result_unknown', '连接断开', 'unknown-log');
          if (mode === 'hang') return new Promise(() => {});
          const request = object(input);
          if (request.expectedRevision !== revision) throw new HostError('http', 'revision_conflict', '已变更', 'conflict-log', 409);
          assert.ok(isJsonValue(request.value));
          value = request.value;
          revision += 'n';
          return { data: { value, revision }, logId: `${id}-write-log` };
        } },
      ] },
      activate: async context => {
        contexts.set(id, context);
        assert.ok(context.data); assert.ok(context.ui); assert.ok(context.extensions?.points);
        const definition: DataSourceDefinition = {
          id: `${id}.${options.longIdentity ? 's'.repeat(150) : 'settings'}`, version: '1', title: '插件设置',
          readOnly: false, applyPolicy: 'reload', ...(options.persistence ? { persistence: options.persistence } : {}),
          ...(options.schema === undefined ? {} : { schema: options.schema }),
          read: { id: `${id}.read`, version: '1' }, write: { id: `${id}.write`, version: '1' },
        };
        definitions.set(id, definition); releases.set(id, context.data.register(definition));
        context.extensions.points.define({ id: `${id}.toolbar`, version: '1', title: '插件工具栏' });
        context.extensions.points.contribute({ id: `${id}.button`, point: { id: `${id}.toolbar`, version: '1' },
          data: { title: '按钮' }, payload: { localOnly: '不应序列化的本地组件' } });
        context.ui.register({ pages: [{ id: `${id}.page`, title: '插件页面', route: `/plugin/${id}`, workspaceId: `${id}.workspace` }],
          workspaces: [{ id: `${id}.workspace`, title: '工作区' }],
          views: [{ id: `${id}.view`, title: '视图', mount: async () => () => {} }] });
        context.ui.open({ instanceId: `${id}.first`, workspaceId: `${id}.workspace`, provider: { pluginId: id, viewId: `${id}.view` },
          target: { privateContext: '不得在目录输出目标内容' } });
        context.ui.setTarget(`${id}.first`, null); context.ui.setTarget(`${id}.first`, null);
      },
    } });
    return manager.load(id);
  }
  const loaded = await load('example');
  const target = { plugin_id: 'example', generation: String(loaded.generation) };
  const execute = (tool: string, parameters: JsonValue = {}, signal = lifetime.signal) =>
    debuggerLocal.execute(tool, target, parameters, signal);
  async function sourceId() {
    const catalog = object(await execute('data_catalog'));
    const source = object(array(catalog.sources)[0]);
    assert.equal(typeof source.id, 'string'); assert.ok(typeof source.id === 'string');
    return { id: source.id, info: source };
  }
  return { calls, contexts, releases, definitions, manager, local: debuggerLocal, target, load, execute, sourceId,
    setValue(next: JsonValue) { value = next; revision += 'changed'; },
    setMode(next: typeof mode) { mode = next; },
    async close() { debuggerLocal.dispose(); await manager.dispose(); extensions.dispose(); dom.window.close(); } };
}

test('调试器自动发现公开源与统一目录，按目标代次过滤且不执行采集', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.execute('inspect'), code('debugger_target_not_selected'));
    await f.load('other'); f.local.select([f.target]);
    const inspected = object(await f.execute('inspect'));
    const catalog = object(inspected.catalog);
    assert.equal(array(object(catalog.extension_points).definitions).length, 1);
    assert.equal(array(object(catalog.extension_points).contributions).length, 1);
    const workspace = object(catalog.workspace);
    assert.equal(array(workspace.pages).length, 1); assert.equal(array(workspace.views).length, 1);
    assert.equal(array(workspace.instances).length, 1, '实例轮换号与插件代次不同仍能正确归属');
    const serialized = JSON.stringify(catalog);
    assert.ok(!serialized.includes('"payload"')); assert.ok(!serialized.includes('localOnly'));
    assert.ok(!serialized.includes('privateContext')); assert.ok(!serialized.includes('other.'));
    assert.deepEqual(f.calls, [], '检查目录不能自动读取业务数据');
    const source = await f.sourceId();
    assert.equal(source.info.persistence, null); assert.equal(source.info.persistence_known, false);
    assert.deepEqual(source.info.source_ref, { id: 'example.settings', version: '1' });
    const capability = object(inspected.capabilities);
    assert.equal(capability.data_read, true); assert.equal(capability.data_write, true);
  } finally { await f.close(); }
});

test('公开源读写保留日志、生效策略与确认，长标识和原修订不截断不泄漏', async () => {
  const f = await fixture({ persistence: 'persistent', longIdentity: true });
  try {
    f.local.select([f.target]); const source = await f.sourceId();
    assert.ok(source.id.length <= 128); assert.equal(source.info.persistence, 'persistent');
    const initial = object(await f.execute('data_read', { source_id: source.id }));
    assert.equal(initial.logId, 'example-read-log'); assert.deepEqual(initial.value, { name: '原名', fixed: 1 });
    assert.ok(typeof initial.revision === 'string' && initial.revision.length < 128);
    await assert.rejects(f.execute('data_write', { source_id: source.id, expected_revision: initial.revision, value: { name: '新名' } }),
      code('debugger_confirmation_required'));
    const saved = object(await f.execute('data_write', { source_id: source.id, expected_revision: initial.revision,
      value: { name: '新名' }, confirmed: true }));
    assert.equal(saved.logId, 'example-write-log'); assert.deepEqual(saved.value, { name: '新名' });
    assert.equal(saved.runtime_applied, 'pending'); assert.equal(saved.apply_policy, 'reload');
    assert.equal(f.calls.filter(id => id === 'example.write').length, 1);
  } finally { await f.close(); }
});

test('公开源保持模式与只读字段约束，冲突保留草稿且原服务只调用一次', async () => {
  const f = await fixture({ schema: { type: 'object', properties: {
    name: { type: 'string' }, fixed: { type: 'number', readOnly: true },
  }, required: ['name', 'fixed'], additionalProperties: false } });
  try {
    f.local.select([f.target]); const source = await f.sourceId();
    const initial = object(await f.execute('data_read', { source_id: source.id }));
    await assert.rejects(f.execute('data_write', { source_id: source.id, expected_revision: revisionOf(initial),
      value: { name: '草稿', fixed: 2 }, confirmed: true }), code('debugger_data_read_only'));
    await assert.rejects(f.execute('data_write', { source_id: source.id, expected_revision: revisionOf(initial),
      value: { name: 3, fixed: 1 }, confirmed: true }), code('debugger_invalid_data'));
    assert.equal(f.calls.filter(id => id === 'example.write').length, 0);
    f.setMode('conflict');
    const draft = { name: '草稿', fixed: 1 };
    await assert.rejects(f.execute('data_write', { source_id: source.id, expected_revision: revisionOf(initial),
      value: draft, confirmed: true }), code('debugger_revision_conflict', 'conflict-log'));
    assert.deepEqual(draft, { name: '草稿', fixed: 1 });
    assert.equal(f.calls.filter(id => id === 'example.write').length, 1);
  } finally { await f.close(); }
});

test('公开源敏感字段脱敏并阻止整体修改，不把未知写入当成功或重试', async () => {
  const f = await fixture();
  try {
    f.local.select([f.target]); const source = await f.sourceId();
    f.setValue({ name: '业务', access_token: '不能泄露的值' });
    const sensitive = object(await f.execute('data_read', { source_id: source.id }));
    assert.ok(!JSON.stringify(sensitive).includes('不能泄露的值'));
    await assert.rejects(f.execute('data_write', { source_id: source.id, expected_revision: revisionOf(sensitive),
      value: { name: '草稿' }, confirmed: true }), code('debugger_sensitive_data_write'));
    f.setValue({ name: '业务' }); f.setMode('unknown');
    const initial = object(await f.execute('data_read', { source_id: source.id }));
    await assert.rejects(f.execute('data_write', { source_id: source.id, expected_revision: revisionOf(initial),
      value: { name: '草稿' }, confirmed: true }), code('debugger_result_unconfirmed', 'unknown-log'));
    assert.equal(f.calls.filter(id => id === 'example.write').length, 1);
  } finally { await f.close(); }
});

test('公开源撤销重新登记、跨目标及卸载后旧标识和修订不能复用', async () => {
  const f = await fixture();
  try {
    f.local.select([f.target]); const source = await f.sourceId();
    const initial = object(await f.execute('data_read', { source_id: source.id }));
    const other = await f.load('other');
    const otherTarget = { plugin_id: 'other', generation: String(other.generation) };
    f.local.select([otherTarget]);
    await assert.rejects(f.local.execute('data_read', otherTarget, { source_id: source.id }, new AbortController().signal),
      code('debugger_data_source_unavailable'));
    f.local.select([f.target]);
    await f.releases.get('example')?.();
    const context = f.contexts.get('example'), definition = f.definitions.get('example');
    assert.ok(context?.data); assert.ok(definition);
    f.releases.set('example', context.data.register(definition));
    const replacement = await f.sourceId();
    assert.notEqual(replacement.id, source.id);
    await assert.rejects(f.execute('data_read', { source_id: source.id }), code('debugger_data_source_unavailable'));
    await assert.rejects(f.execute('data_write', { source_id: replacement.id, expected_revision: revisionOf(initial),
      value: { name: '旧草稿' }, confirmed: true }), code('debugger_revision_conflict'));
    await f.manager.unload('example');
    await assert.rejects(f.execute('data_read', { source_id: replacement.id }), code('debugger_target_unavailable'));
  } finally { await f.close(); }
});

test('公开写入派发后取消有界收敛为未知结果，不自动重放', async () => {
  const f = await fixture();
  try {
    f.local.select([f.target]); const source = await f.sourceId();
    const initial = object(await f.execute('data_read', { source_id: source.id }));
    f.setMode('hang');
    const caller = new AbortController();
    const pending = f.execute('data_write', { source_id: source.id, expected_revision: revisionOf(initial),
      value: { name: '草稿' }, confirmed: true }, caller.signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(id => id === 'example.write').length, 1);
    caller.abort();
    await assert.rejects(pending, code('debugger_result_unconfirmed'));
    assert.equal(f.calls.filter(id => id === 'example.write').length, 1);
  } finally { await f.close(); }
});

test('统一调试目录与数据适配通过定向严格类型检查', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([fileURLToPath(import.meta.url)], parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file &&
    (/\/debugger-local\/|\/debugger-unified-catalog\.test\.ts$|\/plugin-sdk\/data-sources\.ts$/)
      .test(diagnostic.file.fileName.replaceAll('\\', '/')));
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
});
