import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAccess, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { createDebuggerController } from '../../examples/browser-debugger/src/controller.ts';
import { decodeActivity, json, object, text } from '../../examples/browser-debugger/src/protocol.ts';
import type { Target } from '../../examples/browser-debugger/src/protocol.ts';

const target: Target = { kind: 'browser', instanceId: 'window', pluginId: 'example', generation: '1', version: '1' };
const second: Target = { ...target, pluginId: 'second', generation: '2' };
const dto = (value: Target) => ({ target_kind: value.kind, instance_id: value.instanceId, plugin_id: value.pluginId,
  generation: value.generation, version: value.version });
const receipt = (response: JsonValue) => ({ command_id: 'command', state: 'succeeded', response });
interface Request { readonly name: string; readonly input: Record<string, unknown>; readonly signal: AbortSignal }
function fixture(custom?: (value: Request) => JsonValue | undefined | Promise<JsonValue | undefined>) {
  const lifetime = new AbortController(), requests: Request[] = [], targets = new Map<string, JsonValue>();
  let sequence = 0;
  const extensions: ExtensionAccess = {
    catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
    executeCommand: async () => { throw new Error('测试不直接调用公开命令'); },
    async callService(_id, _version, source, signal) {
      const raw = object(source), name = text(raw.name), input = object(raw.input), action = text(raw.action);
      const request = { name, input, signal }; requests.push(request);
      const override = await custom?.(request);
      if (override !== undefined) return { data: override, logId: 'log' };
      if (action === 'capabilities' || action === 'status') return { data: { bridge: { state: 'connected', instanceId: 'window' } }, logId: null };
      if (action === 'start') return { data: { instance_id: 'window' }, logId: null };
      if (action === 'reconnect') return { data: { instance_id: 'window-2' }, logId: null };
      if (name === 'deviceforge.debug_targets') return { data: { browser_targets: [dto(target), dto(second)] }, logId: null };
      if (name === 'deviceforge.debug_session') {
        if (input.action === 'open') {
          const id = `session-${++sequence}`; targets.set(id, json(input.target));
          return { data: { session_id: id, state: 'active', target: json(input.target) }, logId: null };
        }
        return { data: { state: 'closed' }, logId: null };
      }
      if (name === 'deviceforge.debug_inspect') return { data: receipt({ roots: [], catalog: {} }), logId: null };
      if (name === 'deviceforge.debug_activity') return { data: { target: targets.get(text(input.session_id)) ?? null,
        items: [], next_before: null, gap: false, retained_only: true }, logId: null };
      if (name === 'deviceforge.debug_data_catalog') return { data: receipt({ sources: [{ id: 'settings', label: '业务配置',
        schema: { type: 'object', properties: { prefix: { type: 'string' } } }, schema_complete: true,
        writable: true, persistence: 'persistent', apply_policy: 'next_invocation' }] }), logId: null };
      if (name === 'deviceforge.debug_data_read') return { data: receipt({ source_id: 'settings', revision: 'revision-1',
        value: { prefix: '工作' }, writable: true, apply_policy: 'next_invocation' }), logId: null };
      if (name === 'deviceforge.debug_data_write') return { data: receipt({ source_id: 'settings', revision: 'revision-2',
        value: json(object(input.parameters).value), writable: true, apply_policy: 'next_invocation', runtime_applied: 'pending' }), logId: null };
      throw new Error(`未预期请求 ${name}`);
    },
    subscribeEvent: () => () => {}, emitEvent: () => {}, getState: () => undefined, setState: () => {}, subscribeState: () => () => {},
  };
  const context: Pick<HostContext, 'signal' | 'extensions'> = { signal: lifetime.signal, extensions };
  return { requests, controller: createDebuggerController(context) };
}

test('活动分页按观察会话顶层传参数并读取最新详情，label与状态独立', async () => {
  const { controller, requests } = fixture(({ name, input }) => name === 'deviceforge.debug_activity' ? {
    target: dto(target), items: [{ sequence: 12, command_id: 'agent-command', tool: 'automation_run', state: 'failed',
      steps: [{ id: 'step', tool: 'data_read', label: '肯定成功' }], response: input.command_id ? { status: 'failed', steps: [] } : null }],
    next_before: null, gap: true, retained_only: true,
  } : undefined);
  try {
    await controller.open(); await controller.select(target);
    const calls = requests.filter((entry) => entry.name === 'deviceforge.debug_activity');
    assert.deepEqual(calls.map((entry) => entry.input), [{ session_id: 'session-1', limit: 20 }, { session_id: 'session-1', command_id: 'agent-command' }]);
    assert.equal(controller.snapshot().activityDetail?.state, 'failed');
    assert.equal(controller.snapshot().activityDetail?.steps[0]?.label, '肯定成功');
    assert.equal(controller.snapshot().activity?.gap, true);
    assert.equal(controller.snapshot().tree, null);
  } finally { await controller.dispose(); }
});

test('活动回执缺目标或来自其他窗口和代次都拒绝', () => {
  assert.throws(() => decodeActivity({ items: [] }, target), /当前明确目标/);
  for (const foreign of [{ ...target, instanceId: 'other' }, { ...target, generation: '2' }, second])
    assert.throws(() => decodeActivity({ target: dto(foreign), items: [] }, target), /当前明确目标/);
});

test('旧宿主活动能力缺失明确显示不可用且手动数据仍可读取', async () => {
  const { controller } = fixture(({ name }) => {
    if (name === 'deviceforge.debug_activity') {
      const error = new Error('当前工具未提供'); Object.assign(error, { code: 'debugger_capability_unavailable' }); throw error;
    }
    return undefined;
  });
  try {
    await controller.open(); await controller.select(target);
    assert.match(controller.snapshot().activity?.unavailable ?? '', /尚不支持/);
    assert.equal(controller.snapshot().error, null);
    await controller.refreshDataSources(); await controller.readDataSource('settings');
    assert.equal(controller.snapshot().dataSnapshot?.revision, 'revision-1');
  } finally { await controller.dispose(); }
});

test('真实前缀修订冲突保留快照且不重放，下一次成功保留待生效策略', async () => {
  let writeCount = 0;
  const { controller } = fixture(({ name }) => name === 'deviceforge.debug_data_write' && ++writeCount === 1 ? {
    command_id: 'failed-write', state: 'failed', response: { error: { code: 'debugger_revision_conflict', message: '已变化' } },
  } : undefined);
  try {
    await controller.open(); await controller.select(target); await controller.refreshDataSources(); await controller.readDataSource('settings');
    await controller.writeDataSource('settings', 'revision-1', { prefix: '我的编辑' }, true);
    assert.equal(writeCount, 1); assert.equal(controller.snapshot().dataConflict, true);
    assert.equal(controller.snapshot().dataSnapshot?.revision, 'revision-1');
    assert.deepEqual(controller.snapshot().dataSnapshot?.value, { prefix: '工作' });
    await controller.writeDataSource('settings', 'revision-1', { prefix: '我的编辑' }, true);
    assert.equal(writeCount, 2); assert.equal(controller.snapshot().dataConflict, false);
    assert.match(controller.snapshot().dataNotice ?? '', /待下次调用/);
  } finally { await controller.dispose(); }
});

test('其他数据源回执不覆盖当前快照，未知写入只显示未确认', async () => {
  let reads = 0;
  const { controller, requests } = fixture(({ name }) => {
    if (name === 'deviceforge.debug_data_read' && ++reads > 1) return receipt({ source_id: 'other', revision: 'foreign', value: {} });
    if (name === 'deviceforge.debug_data_write') return { command_id: 'unknown', state: 'timed_out_unconfirmed', response: null };
    return undefined;
  });
  try {
    await controller.open(); await controller.select(target); await controller.refreshDataSources(); await controller.readDataSource('settings');
    await controller.readDataSource('settings');
    assert.equal(controller.snapshot().dataSnapshot?.revision, 'revision-1');
    await controller.writeDataSource('settings', 'revision-1', {}, true);
    assert.equal(controller.snapshot().error?.unconfirmed, true);
    assert.equal(requests.filter((entry) => entry.name === 'deviceforge.debug_data_write').length, 1);
  } finally { await controller.dispose(); }
});

test('无树的数据和活动快照重连后仍过期，旧代晚到冲突不污染新目标', async () => {
  let release: (value: JsonValue) => void = () => {}, waiting = false;
  const late = new Promise<JsonValue>((resolve) => { release = resolve; });
  const { controller } = fixture(({ name }) => name === 'deviceforge.debug_data_write' ? (waiting = true, late) : undefined);
  try {
    await controller.open(); await controller.select(target); await controller.refreshDataSources(); await controller.readDataSource('settings');
    assert.equal(controller.snapshot().tree, null);
    await controller.reconnect(true); assert.equal(controller.snapshot().stale, true);
    await controller.select(target); await controller.refreshDataSources();
    const writing = controller.writeDataSource('settings', 'revision-1', {}, true);
    for (let index = 0; index < 20 && !waiting; index++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(waiting, true);
    await controller.select(second);
    release({ command_id: 'old', state: 'failed', response: { error: { code: 'debugger_revision_conflict', message: '旧代冲突' } } });
    await writing;
    assert.equal(controller.snapshot().target?.pluginId, 'second');
    assert.equal(controller.snapshot().dataConflict, false); assert.equal(controller.snapshot().dataNotice, null);
  } finally { await controller.dispose(); }
});
