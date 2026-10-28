import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAccess, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { createDebuggerController } from '../../examples/browser-debugger/src/controller.ts';
import { createGateway, DebuggerFailure, json, object, text } from '../../examples/browser-debugger/src/protocol.ts';
import type { Target } from '../../examples/browser-debugger/src/protocol.ts';

const target: Target = { kind: 'browser', instanceId: 'instance-current', pluginId: 'example', generation: '7', version: '1.0.0' };
const second: Target = { ...target, pluginId: 'second', generation: '8' };
const signal = () => new AbortController().signal;
function tree(id = 'snapshot-1', nodeId = 'node-1') {
  return { id, observedAt: 1793130000000, owner: { pluginId: 'example', generation: 7 }, revision: 2,
    nodes: [{ id: nodeId, generation: 7, revision: 2, parentId: null, role: 'button', name: '确认',
      actionPolicy: 'unknown', hidden: 'no', disabled: 'no', visible: 'unknown' }],
    coverage: { completeness: 'observed-dom-only', truncation: [] }, bytes: 300 };
}
interface Request { readonly action: string; readonly name: string; readonly input: Record<string, unknown>; readonly signal: AbortSignal }
function fixture(custom?: (request: Request) => Promise<JsonValue | undefined> | JsonValue | undefined) {
  const requests: Request[] = [], lifetime = new AbortController();
  let sequence = 0;
  const extensions: ExtensionAccess = {
    catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
    executeCommand: async () => { throw new Error('不应绕过调试公开服务'); },
    async callService(id, version, request, caller) {
      assert.equal(id, 'host.debugger'); assert.equal(version, '1');
      const raw = object(request), action = text(raw.action), name = text(raw.name);
      const entry = { action, name, input: object(raw.input), signal: caller }; requests.push(entry);
      const override = await custom?.(entry);
      if (override !== undefined) return { data: override, logId: 'actual-log-id' };
      if (action === 'capabilities' || action === 'status') return { data: { bridge: { state: 'connected', instanceId: 'instance-current' }, reload_timeout_ms: 50000 }, logId: null };
      if (action === 'start') return { data: { instance_id: 'instance-current' }, logId: null };
      if (action === 'reconnect') return { data: { instance_id: 'instance-new', bridge: { state: 'connected' } }, logId: null };
      if (action === 'logs') return { data: { entries: [{ level: 'ERROR', message: '公开错误', log_id: 'log-public' }], limited: true }, logId: 'log-search' };
      if (action === 'installation') return { data: { installations: [], standalone: [{ id: 'example', digest: null, digest_status: 'unknown' }], running: [] }, logId: null };
      assert.equal(action, 'call');
      if (name === 'deviceforge.debug_targets') return { data: { browser_instances: [{ instance_id: 'instance-current', plugins: [
        { plugin_id: 'example', generation: '7', version: '1.0.0' }, { plugin_id: 'second', generation: '8', version: '1.0.0' },
      ] }], server_plugins: [{ id: 'server', generation: 'server-g1', version: '2.0' }] }, logId: null };
      if (name === 'deviceforge.debug_session') {
        if (entry.input.action === 'open') return { data: { session_id: `session-${++sequence}`, state: 'active', target: json(entry.input.target) }, logId: null };
        if (entry.input.action === 'get') return { data: { session_id: json(entry.input.session_id), state: 'active', target: {
          target_kind: target.kind, instance_id: target.instanceId, plugin_id: target.pluginId, generation: target.generation, version: target.version,
        } }, logId: null };
        return { data: { state: 'closed' }, logId: null };
      }
      const parameters = object(entry.input.parameters);
      let response: JsonValue = { status: 'applied', reason: '公开结果' };
      if (name === 'deviceforge.debug_inspect') response = { roots: [{ root_id: 'root-1', contribution_id: 'example.main' }],
        catalog: { commands: [{ id: 'example.command' }], services: [{ id: 'example.service', version: '1', available: true,
          inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: false } }] },
        capabilities: { pick: true }, cleanup_history: [{ generation: '6', state: 'cleanup_failed' }] };
      if (name === 'deviceforge.debug_ui_tree') response = parameters.view === 'overview' ? { status: 'catalog', nodes: [], page: { nextOffset: null, total: 0 } }
        : { root_id: json(parameters.root_id), tree: tree() };
      if (name === 'deviceforge.debug_events') return { data: { events: [{ sequence: 12, kind: 'command_finished', command_state: 'succeeded' }],
        next_after: 12, gap: true, dropped_events: 4 }, logId: 'event-log' };
      if (name === 'deviceforge.debug_ui_query') response = { nodes: [tree().nodes[0] ?? null], complete: false, reason: '仅观测 DOM' };
      if (name === 'deviceforge.debug_invoke') response = { data: null, logId: 'business-log', result_metadata: { included: false, bytes: null, type: 'object' } };
      if (name === 'deviceforge.debug_report') return { data: { report: { evidence: { snapshot_manifest: [] } }, artifact: {
        format: 'json', download_url: '/public-artifact', metadata: { id: 'artifact-1', filename: 'report.json' },
      } }, logId: 'report-log' };
      return { data: { command_id: `command-${requests.length}`, session_id: json(entry.input.session_id),
        state: 'succeeded', response }, logId: 'actual-log-id' };
    },
    subscribeEvent: () => () => {}, emitEvent: () => {}, getState: () => undefined, setState: () => {}, subscribeState: () => () => {},
  };
  const context: Pick<HostContext, 'extensions' | 'signal'> = { extensions, signal: lifetime.signal };
  return { context, requests, lifetime, controller: createDebuggerController(context) };
}

test('插件初始只有入口，无联网、会话和结构采集；打开默认连接当前实例', async () => {
  const { controller, requests } = fixture();
  try {
    assert.equal(controller.snapshot().open, false); assert.equal(requests.length, 0);
    await controller.open();
    assert.equal(controller.snapshot().instanceId, 'instance-current');
    assert.deepEqual(requests.map((item) => item.action), ['capabilities', 'start', 'call']);
    assert.equal(requests[2]?.name, 'deviceforge.debug_targets');
    assert.equal(controller.snapshot().sessionId, null); assert.equal(controller.snapshot().tree, null);
  } finally { await controller.dispose(); }
});

test('明确目标后按response解包检查与树，收起不关闭会话，关闭独立释放', async () => {
  const { controller, requests } = fixture();
  try {
    await controller.open(); await controller.select(target);
    assert.equal(controller.snapshot().tree?.nodes[0]?.id, 'node-1');
    assert.equal(controller.snapshot().inspection !== null, true);
    assert.equal(controller.snapshot().entries.length, 2);
    controller.collapse();
    assert.equal(requests.filter((item) => item.input.action === 'close').length, 0);
    assert.equal(controller.snapshot().sessionId, 'session-1');
    await controller.close();
    assert.equal(controller.snapshot().sessionId, null); assert.equal(controller.snapshot().stale, true);
    assert.equal(requests.filter((item) => item.input.action === 'close').length, 1);
    assert.equal(requests.some((item) => /unload|cancel_job/.test(item.name)), false);
  } finally { await controller.dispose(); }
});

test('多挂载根不任意选取，明确选择后才读取', async () => {
  const { controller, requests } = fixture(({ name }) => name === 'deviceforge.debug_inspect' ? {
    command_id: 'inspect', state: 'succeeded', response: { roots: [{ root_id: 'one' }, { root_id: 'two' }], catalog: {} },
  } : undefined);
  try {
    await controller.open(); await controller.select(target);
    assert.equal(controller.snapshot().rootId, ''); assert.equal(controller.snapshot().tree, null);
    assert.equal(requests.some((item) => item.name === 'deviceforge.debug_ui_tree'), false);
    await controller.tree(); assert.match(controller.snapshot().error?.message ?? '', /挂载根/);
    controller.setRoot('two'); await controller.tree();
    assert.equal(object(requests.at(-1)?.input.parameters).root_id, 'two');
    assert.equal(controller.snapshot().tree?.id, 'snapshot-1');
  } finally { await controller.dispose(); }
});

test('切换目标隔离忽略取消的旧代晚到结构结果', async () => {
  let release: (value: JsonValue) => void = () => {}; let waiting = false;
  const late = new Promise<JsonValue>((resolve) => { release = resolve; });
  const { controller } = fixture(({ name }) => name === 'deviceforge.debug_ui_tree' && !waiting ? (waiting = true, late) : undefined);
  try {
    await controller.open(); const previous = controller.select(target);
    for (let i = 0; i < 20 && !waiting; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(waiting, true);
    await controller.select(second);
    release({ command_id: 'old', state: 'succeeded', response: { root_id: 'old-root', tree: tree('old-snapshot', 'old-node') } });
    await previous;
    assert.equal(controller.snapshot().target?.pluginId, 'second'); assert.equal(controller.snapshot().tree?.id, 'snapshot-1');
    assert.equal(controller.snapshot().tree?.nodes.some((node) => node.id === 'old-node'), false);
  } finally { await controller.dispose(); }
});

test('失败回执读取response.error，日志ID保留；未知结果不重放且不封锁独立新动作', async () => {
  let calls = 0;
  const { controller, requests } = fixture(({ name }) => name === 'deviceforge.debug_ui_action' && ++calls === 1 ? {
    command_id: 'action', state: 'timed_out_unconfirmed', response: { error: { code: 'debugger_result_unconfirmed', message: '原动作可能已发生' } },
  } : undefined);
  try {
    await controller.open(); await controller.select(target);
    const node = controller.snapshot().tree?.nodes[0]; assert.ok(node);
    await controller.action('click', node, '', false, false);
    assert.equal(calls, 0);
    await controller.action('click', node, '', true, true);
    assert.equal(controller.snapshot().error?.unconfirmed, true); assert.equal(controller.snapshot().logId, 'actual-log-id');
    assert.equal(calls, 1); assert.equal(controller.snapshot().stale, false);
    await controller.action('highlight', node, '', false, false);
    assert.equal(calls, 2); assert.equal(controller.snapshot().error, null);
    assert.equal(requests.filter((item) => item.name === 'deviceforge.debug_ui_action').length, 2);
    assert.ok(controller.snapshot().events.some((event) => event.level === 'error'));
  } finally { await controller.dispose(); }
});

test('桥断线保留过期快照且阻断旧节点动作，重连显式且不重放', async () => {
  const { controller, requests } = fixture(({ action }) => action === 'status' ? { bridge: { state: 'disconnected', instanceId: 'instance-current', reason: '桥已断线' } } : undefined);
  try {
    await controller.open(); await controller.select(target); await controller.checkConnection();
    assert.equal(controller.snapshot().stale, true); assert.equal(controller.snapshot().tree?.id, 'snapshot-1');
    const count = requests.length; const node = controller.snapshot().tree?.nodes[0]; assert.ok(node);
    await controller.action('click', node, '', true, true); assert.equal(requests.length, count);
    await controller.reconnect(false); assert.equal(requests.some((item) => item.action === 'reconnect'), false);
    await controller.reconnect(true);
    assert.equal(controller.snapshot().instanceId, 'instance-new'); assert.equal(controller.snapshot().stale, true);
    assert.equal(requests.filter((item) => item.name === 'deviceforge.debug_ui_action').length, 0);
    assert.equal(requests.filter((item) => item.input.action === 'open').length, 1);
  } finally { await controller.dispose(); }
});

test('事件分页精确传游标并保留缺口、旧失败与当前成功', async () => {
  const { controller, requests } = fixture();
  try {
    await controller.open(); await controller.select(target);
    await controller.action('click', null, '', true, true);
    await controller.events(); await controller.events();
    const pages = requests.filter((item) => item.name === 'deviceforge.debug_events');
    assert.equal(pages[0]?.input.after, 0); assert.equal(pages[1]?.input.after, 12);
    assert.equal(controller.snapshot().eventGap, true); assert.equal(controller.snapshot().droppedEvents, 4);
    assert.equal(controller.snapshot().events.some((event) => event.level === 'error'), true);
    assert.equal(controller.snapshot().events.filter((event) => event.key === 'session-1:12').length, 1);
  } finally { await controller.dispose(); }
});

test('试调用仅允许当前catalog并显式双确认，默认仅元数据', async () => {
  const { controller, requests } = fixture();
  try {
    await controller.open(); await controller.select(target);
    const entry = controller.snapshot().entries.find((item) => item.kind === 'service'); assert.ok(entry);
    await controller.invoke(entry, { value: 'ok' }, false, true);
    assert.equal(requests.some((item) => item.name === 'deviceforge.debug_invoke'), false);
    await controller.invoke(entry, { value: 'ok' }, true, true);
    const parameters = object(requests.find((item) => item.name === 'deviceforge.debug_invoke')?.input.parameters);
    assert.deepEqual(parameters, { kind: 'service', id: 'example.service', input: { value: 'ok' }, confirmed: true,
      allow_unknown_side_effects: true, include_result: false, version: '1' });
    assert.equal(object(controller.snapshot().result).data, null);
  } finally { await controller.dispose(); }
});

test('树分页绑定原快照与根，不把分页当成新快照', async () => {
  let page = 0;
  const { controller, requests } = fixture(({ name, input }) => {
    if (name !== 'deviceforge.debug_ui_tree') return undefined;
    const parameters = object(input.parameters); page++;
    return { command_id: `page-${page}`, state: 'succeeded', response: { root_id: 'root-1', tree: { ...tree('stable', parameters.offset ? 'node-2' : 'node-1'),
      page: { snapshotId: 'stable', offset: typeof parameters.offset === 'number' ? parameters.offset : 0, limit: 1, nextOffset: parameters.offset ? null : 1, total: 2 } } } };
  });
  try {
    await controller.open(); await controller.select(target); await controller.nextTreePage();
    assert.equal(controller.snapshot().tree?.nodes.length, 2); assert.equal(controller.snapshot().trees.length, 1);
    assert.deepEqual(object(requests.at(-1)?.input.parameters), { root_id: 'root-1', snapshot_id: 'stable', offset: 1, limit: 500 });
  } finally { await controller.dispose(); }
});

test('市场成套候选打开并筛选，但不任意创建组件会话', async () => {
  const { controller, requests } = fixture();
  try {
    await controller.requestTargets([{ kind: 'browser', pluginId: 'example' }, { kind: 'server', pluginId: 'server' }], 'installation');
    assert.equal(controller.snapshot().open, true); assert.equal(controller.snapshot().requested?.candidates.length, 2);
    assert.equal(controller.snapshot().sessionId, null); assert.equal(requests.some((item) => item.input.action === 'open'), false);
  } finally { await controller.dispose(); }
});

test('日志搜索和安装摘要只通过公开服务，保留limited和未知digest', async () => {
  const { controller, requests } = fixture();
  try {
    await controller.logs('log-id', true); await controller.logs('关键词', false); await controller.installation();
    assert.deepEqual(requests[0]?.input, { log_id: 'log-id', order: 'desc' });
    assert.deepEqual(requests[1]?.input, { q: '关键词', order: 'desc' });
    assert.equal(object(controller.snapshot().logs).limited, true);
    assert.equal(object(controller.snapshot().installation).standalone !== undefined, true);
  } finally { await controller.dispose(); }
});

test('报告按真实export合同发送并兼容artifact.metadata，导航不带root_id', async () => {
  const { controller, requests } = fixture();
  try {
    await controller.open(); await controller.select(target); await controller.report(true, 'markdown');
    assert.equal(object(object(object(controller.snapshot().report).artifact).metadata).id, 'artifact-1');
    assert.deepEqual(object(requests.at(-1)?.input.parameters), { export: 'markdown' });
    await controller.navigate('/devices', true);
    assert.deepEqual(object(requests.at(-1)?.input.parameters), { action: { type: 'navigate', path: '/devices', confirmed: true } });
  } finally { await controller.dispose(); }
});

test('公开gateway拒绝错误回执并保留结构化错误与日志ID', async () => {
  const { context, controller } = fixture(() => ({ command_id: 'command', state: 'failed', response: { error: { code: 'debugger_target_changed', message: '目标已变' } } }));
  try {
    const gateway = createGateway(context);
    await assert.rejects(gateway.call('inspect', { session_id: 'session', parameters: {} }, signal()), (error: unknown) =>
      error instanceof DebuggerFailure && error.code === 'debugger_target_changed' && error.logId === 'actual-log-id');
  } finally { await controller.dispose(); }
});

test('拾取发送冻结参数并保留其他插件归属，不自动切换目标', async () => {
  const { controller, requests } = fixture(({ name }) => name === 'deviceforge.debug_ui_action' ? {
    command_id: 'pick', state: 'succeeded', response: { status: 'indeterminate', target: null,
      owner: { pluginId: 'other', generation: 9 }, root_id: null, reason: '须显式选择其他插件' },
  } : undefined);
  try {
    await controller.open(); await controller.select(target); await controller.action('pick', null, '', false, false);
    assert.deepEqual(object(requests.at(-1)?.input.parameters), { action: { type: 'pick' } });
    assert.equal(controller.snapshot().target?.pluginId, 'example');
    assert.equal(object(object(controller.snapshot().result).owner).pluginId, 'other');
    assert.equal(controller.snapshot().error, null);
  } finally { await controller.dispose(); }
});

test('服务器操作与服务精确遵守合同，不发送include_result或操作version', async () => {
  const { controller, requests } = fixture(({ name }) => name === 'deviceforge.debug_inspect' ? {
    operations: [{ id: 'plugin.server.action', input_schema: { type: 'object' } }],
    services: [{ service: { id: 'server.service', version: '2' }, available: true,
      contract: { input_schema: { type: 'object' } } }],
  } : undefined);
  try {
    await controller.open(); await controller.select({ kind: 'server', instanceId: null, pluginId: 'server', generation: 'server-g1', version: '2.0' });
    const operation = controller.snapshot().entries.find((entry) => entry.kind === 'operation');
    const service = controller.snapshot().entries.find((entry) => entry.kind === 'service'); assert.ok(operation); assert.ok(service);
    await controller.invoke(operation, {}, true, true, true);
    assert.deepEqual(object(requests.at(-1)?.input.parameters), { kind: 'operation', id: 'plugin.server.action', input: {}, confirmed: true, allow_unknown_side_effects: true });
    await controller.invoke(service, {}, true, true, true);
    assert.deepEqual(object(requests.at(-1)?.input.parameters), { kind: 'service', id: 'server.service', version: '2', input: {}, confirmed: true, allow_unknown_side_effects: true });
  } finally { await controller.dispose(); }
});

test('报告真实包装和snapshot_manifest引导ui_tree续页，不向debug_report发送局部参数', async () => {
  const { controller, requests } = fixture(({ name, input }) => {
    if (name === 'deviceforge.debug_report') return { report: { evidence: { cached_trees: [],
      snapshot_manifest: [{ root_id: 'root-1', snapshots: [{ id: 'frozen-report', total: 1, pages: 1 }] }],
      continuation: { root_id: 'root-1', snapshot_id: 'frozen-report', offset: 0 } } }, artifact: null };
    if (name === 'deviceforge.debug_ui_tree' && object(input.parameters).snapshot_id === 'frozen-report')
      return { command_id: 'page', state: 'succeeded', response: { root_id: 'root-1', tree: { ...tree('frozen-report'),
        page: { snapshotId: 'frozen-report', offset: 0, limit: 500, nextOffset: null, total: 1 } } } };
    return undefined;
  });
  try {
    await controller.open(); await controller.select(target); await controller.report(); await controller.reportNext();
    assert.deepEqual(object(requests.find((entry) => entry.name === 'deviceforge.debug_report')?.input.parameters), { export: 'none' });
    assert.equal(requests.at(-1)?.name, 'deviceforge.debug_ui_tree');
    assert.deepEqual(object(requests.at(-1)?.input.parameters), { root_id: 'root-1', snapshot_id: 'frozen-report', offset: 0, limit: 500 });
    assert.equal(controller.snapshot().error, null);
  } finally { await controller.dispose(); }
});

test('重载等待未确认单独标记，保持旧快照且不自动重载第二次', async () => {
  const { controller, requests } = fixture(({ name }) => name === 'deviceforge.debug_reload' ? {
    state: 'timed_out_unconfirmed', automatic_replay: false,
  } : undefined);
  try {
    await controller.open(); await controller.select(target); await controller.reload(true);
    assert.equal(controller.snapshot().error?.unconfirmed, true);
    assert.equal(controller.snapshot().tree?.id, 'snapshot-1');
    assert.equal(requests.filter((entry) => entry.name === 'deviceforge.debug_reload').length, 1);
    assert.equal(controller.snapshot().error?.code, 'timed_out_unconfirmed');
  } finally { await controller.dispose(); }
});

test('拾取宿主普通节点只保留只读身份并清空插件动作选择', async () => {
  const { controller } = fixture(({ name }) => name === 'deviceforge.debug_ui_action' ? {
    command_id: 'host-pick', state: 'succeeded', response: { status: 'picked', owner: null, target: null, root_id: null,
      source: 'host-dom', host: { tag: 'button', role: 'button', label: '宿主按钮', insertable: false }, reason: '只读身份' },
  } : undefined);
  try {
    await controller.open(); await controller.select(target); controller.setNode('node-1');
    await controller.action('pick', null, '', false, false);
    assert.equal(controller.snapshot().selectedNodeId, '');
    assert.equal(object(controller.snapshot().result).source, 'host-dom');
    assert.equal(controller.snapshot().target?.pluginId, 'example');
    assert.equal(controller.snapshot().error, null);
  } finally { await controller.dispose(); }
});

test('选择其他浏览器实例不误用本地桥实例ID判为断线', async () => {
  const foreign: Target = { ...target, instanceId: 'instance-foreign' };
  const { controller } = fixture(({ name, input }) => name === 'deviceforge.debug_session' && input.action === 'get' ? {
    session_id: 'session-1', state: 'active', target: { target_kind: foreign.kind, instance_id: foreign.instanceId,
      plugin_id: foreign.pluginId, generation: foreign.generation, version: foreign.version },
  } : undefined);
  try {
    await controller.open(); await controller.select(foreign); await controller.checkConnection();
    assert.equal(controller.snapshot().stale, false); assert.equal(controller.snapshot().connected, true);
    assert.equal(controller.snapshot().target?.instanceId, 'instance-foreign');
  } finally { await controller.dispose(); }
});
