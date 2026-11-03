import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAccess } from '../src/plugin-sdk/index.ts';
import { createDebuggerController } from '../../examples/browser-debugger/src/controller.ts';
import { object, text } from '../../examples/browser-debugger/src/protocol.ts';

interface Request {
  readonly action: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}
function fixture(phase: 'disconnected' | 'idle' | 'connected' = 'disconnected', snakeCase = false) {
  const lifetime = new AbortController();
  const requests: Request[] = [];
  const extensions: ExtensionAccess = {
    catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
    executeCommand: async () => { throw new Error('连接入口不得执行插件命令'); },
    async callService(id, version, source, signal) {
      signal.throwIfAborted();
      assert.equal(id, 'host.debugger'); assert.equal(version, '1');
      const value = object(source);
      const request = { action: text(value.action), name: text(value.name), input: object(value.input) };
      requests.push(request);
      if (request.action === 'capabilities') return { logId: 'bridge-observation-log', data: {
        bridge: { state: phase, reason: '上次心跳已断开',
          ...(snakeCase ? { instance_id: 'old-instance' } : { instanceId: 'old-instance' }) },
      } };
      if (request.action === 'start') {
        if (phase === 'disconnected') throw new Error('调试桥已经连接或断开，请先关闭并重新创建实例');
        return { logId: null, data: { instance_id: 'current-instance' } };
      }
      if (request.action === 'reconnect') return { logId: 'reconnect-log', data: { instance_id: 'new-instance' } };
      if (request.action === 'call' && request.name === 'deviceforge.debug_targets') return { logId: 'directory-log', data: {
        browser_instances: [{ instance_id: 'new-instance', plugins: [
          { plugin_id: 'business', version: '1.0.0', generation: '2' },
        ] }], server_plugins: [],
      } };
      throw new Error(`连接入口不应派发 ${request.action}/${request.name}`);
    },
    subscribeEvent: () => () => {}, emitEvent: () => {}, getState: () => undefined,
    setState: () => {}, subscribeState: () => () => {},
  };
  return { requests, controller: createDebuggerController({ signal: lifetime.signal, extensions }) };
}

test('尚未选择目标时打开断线桥显示真实断线观测，不误调用启动或采集', async () => {
  const { controller, requests } = fixture();
  try {
    await controller.open();
    const state = controller.snapshot();
    assert.equal(state.open, true);
    assert.equal(state.connected, false);
    assert.equal(state.stale, true);
    assert.equal(state.sessionState, 'disconnected');
    assert.equal(state.instanceId, 'old-instance');
    assert.equal(state.target, null); assert.equal(state.sessionId, null);
    assert.equal(state.error, null); assert.equal(state.busy, null);
    assert.match(state.notice, /上次心跳已断开/);
    assert.equal(state.logId, 'bridge-observation-log');
    assert.deepEqual(requests.map((entry) => entry.action), ['capabilities']);
  } finally { await controller.dispose(); }
});

test('收起后再次打开仍只观察旧桥，不隐式重建实例或回放，兼容下划线实例字段', async () => {
  const { controller, requests } = fixture('disconnected', true);
  try {
    await controller.open(); controller.collapse(); await controller.open();
    assert.equal(controller.snapshot().instanceId, 'old-instance');
    assert.equal(controller.snapshot().stale, true);
    assert.equal(controller.snapshot().error, null);
    assert.deepEqual(requests.map((entry) => entry.action), ['capabilities', 'capabilities']);
  } finally { await controller.dispose(); }
});

test('只有显式确认才重连并读取新目录，不自动选插件或建立业务会话', async () => {
  const { controller, requests } = fixture();
  try {
    await controller.open();
    await controller.reconnect(false);
    assert.equal(requests.some((entry) => entry.action === 'reconnect'), false);
    assert.match(controller.snapshot().error?.message ?? '', /确认/);
    await controller.reconnect(true);
    const state = controller.snapshot();
    assert.equal(state.instanceId, 'new-instance');
    assert.equal(state.connected, true); assert.equal(state.stale, false);
    assert.equal(state.target, null); assert.equal(state.sessionId, null);
    assert.equal(state.error, null);
    assert.deepEqual(state.targets.map((entry) => entry.pluginId), ['business']);
    assert.deepEqual(requests, [
      { action: 'capabilities', name: '', input: {} },
      { action: 'reconnect', name: '', input: { confirmed: true } },
      { action: 'call', name: 'deviceforge.debug_targets', input: {} },
    ]);
  } finally { await controller.dispose(); }
});

test('未启动和已连接桥仍沿原启动及目录入口，不把正常打开当成重连', async () => {
  for (const phase of ['idle', 'connected'] as const) {
    const { controller, requests } = fixture(phase);
    try {
      await controller.open();
      assert.equal(controller.snapshot().instanceId, 'current-instance');
      assert.equal(controller.snapshot().connected, true);
      assert.equal(controller.snapshot().stale, false);
      assert.deepEqual(requests.map((entry) => entry.action), ['capabilities', 'start', 'call']);
      assert.equal(requests[2]?.name, 'deviceforge.debug_targets');
    } finally { await controller.dispose(); }
  }
});
