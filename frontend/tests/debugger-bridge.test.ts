import assert from 'node:assert/strict';
import test from 'node:test';
import { createDebuggerBridge, isLoopbackDebuggerAddress } from '../src/features/debugger/index.ts';
import type { DebuggerGateway, DebuggerSessionDto, DebuggerBatchDto } from '../src/services/api/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { deferred } from './fixtures.ts';

const instanceId = 'cb8fa2a8-3a87-4d94-9d21-cc0e89962bd4';
const target = { target_kind: 'browser' as const, instance_id: instanceId, plugin_id: 'example', generation: '1', version: '1.0' };
const session: DebuggerSessionDto = { session_id: 'session', target, state: 'active', idle_ttl_ms: 1800000 };
const command: DebuggerBatchDto['commands'][number] = { command_id: 'command', session_id: 'session', target,
  tool: 'inspect', parameters: {}, remaining_ms: 1000 };
const result = <T>(data: T) => ({ data, logId: 'actual-log-id' });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await sleep(5); }
  assert.fail('等待调试桥测试条件超时');
}
function gateway(overrides: Partial<DebuggerGateway> = {}): DebuggerGateway {
  return {
    register: async () => result({ instance_id: instanceId, plugins: [], active_sessions: 0, idle_ttl_ms: 90000 }),
    heartbeat: async () => result({ instance_id: instanceId, active_sessions: [], targets: [] }),
    poll: async () => result({ instance_id: instanceId, active_sessions: [], targets: [], commands: [] }),
    acknowledge: async (input) => result({ command_id: input.command_id, session_id: 'session', state: 'succeeded', timeout_ms: 5000 }),
    disconnect: async () => result({ disconnected: true }),
    call: async () => result({}),
    ...overrides,
  };
}

test('明确未受理的状态忙碌只退避心跳与领取，不断桥也不重放动作', async () => {
  let beats = 0, polls = 0, executions = 0, acknowledgements = 0;
  const bridge = createDebuggerBridge({ gateway: gateway({
    heartbeat: async () => {
      if (++beats === 1) throw new ApiError('http', 'debugger_busy', '状态正在更新', 429);
      return result({ instance_id: instanceId, active_sessions: [session], targets: [target] });
    },
    poll: async () => {
      if (++polls === 1) throw new ApiError('http', 'debugger_busy', '状态正在更新', 429);
      return result({ instance_id: instanceId, active_sessions: [session], targets: [target], commands: [command] });
    },
    acknowledge: async input => {
      acknowledgements++;
      return result({ command_id: input.command_id, session_id: 'session', state: 'succeeded', timeout_ms: 5000 });
    },
  }), signal: new AbortController().signal, directory: () => [{ plugin_id: 'example', generation: '1', version: '1.0' }],
    select: () => {}, execute: async () => { executions++; return {}; }, heartbeatMs: 10 });
  try {
    await bridge.start(); await until(() => acknowledgements === 1); await sleep(35);
    assert.ok(beats > 1 && polls > 1); assert.equal(bridge.snapshot().state, 'connected');
    assert.equal(executions, 1); assert.equal(acknowledgements, 1);
  } finally { await bridge.dispose(); }
});

test('空闲心跳之后新建会话仍在默认五秒读取预算内被领取', async () => {
  let selected = false, beats = 0, executions = 0;
  const first = deferred<void>(), acknowledged = deferred<void>();
  const bridge = createDebuggerBridge({ gateway: gateway({
    heartbeat: async () => {
      beats++; if (beats === 1) first.resolve();
      return result({ instance_id: instanceId, active_sessions: selected ? [session] : [], targets: [target] });
    },
    poll: async () => result({ instance_id: instanceId, active_sessions: [session], targets: [target], commands: [command] }),
    acknowledge: async input => { acknowledged.resolve(); return result({ command_id: input.command_id, session_id: 'session', state: 'succeeded', timeout_ms: 5000 }); },
  }), signal: new AbortController().signal, directory: () => [{ plugin_id: 'example', generation: '1', version: '1.0' }],
    select: () => {}, execute: async () => { executions++; return {}; }, heartbeatMs: 5000 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await bridge.start(); await first.promise; await sleep(0); selected = true;
    await Promise.race([acknowledged.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('空闲等待吃完新命令预算')), 2000);
    })]);
    assert.equal(executions, 1); assert.equal(bridge.snapshot().state, 'connected');
  } finally { if (timer) clearTimeout(timer); await bridge.dispose(); }
});

test('无显式会话不领取命令、不采集UI，关闭后停止心跳', async () => {
  let polls = 0, executions = 0, heartbeats = 0, disconnects = 0;
  const bridge = createDebuggerBridge({ gateway: gateway({
    heartbeat: async () => { heartbeats++; return result({ instance_id: instanceId, active_sessions: [], targets: [] }); },
    poll: async () => { polls++; return result({ instance_id: instanceId, active_sessions: [], targets: [], commands: [] }); },
    disconnect: async () => { disconnects++; return result({ disconnected: true }); },
  }), signal: new AbortController().signal, directory: () => [], select: () => {},
    execute: async () => { executions++; return {}; }, heartbeatMs: 10 });
  await bridge.start();
  await sleep(35);
  assert.ok(heartbeats > 0);
  assert.equal(polls, 0); assert.equal(executions, 0);
  await bridge.dispose();
  const count = heartbeats;
  await sleep(25);
  assert.equal(heartbeats, count); assert.equal(disconnects, 1);
  assert.equal(bridge.snapshot().state, 'closed');
});

test('界面与MCP同时观察同一插件时只建立一个采集目标，关闭其中一个不撤销另一个', async () => {
  let sessions: DebuggerSessionDto[] = [session, { ...session, session_id: 'second-session' }];
  const selections: { plugin_id: string; generation: string | null }[][] = [];
  const bridge = createDebuggerBridge({ gateway: gateway({
    heartbeat: async () => result({ instance_id: instanceId, active_sessions: sessions, targets: [target] }),
    poll: async () => result({ instance_id: instanceId, active_sessions: sessions, targets: [target], commands: [] }),
  }), signal: new AbortController().signal, directory: () => [{ plugin_id: 'example', generation: '1', version: '1.0' }],
    select: targets => { selections.push([...targets]); }, execute: async () => ({}), heartbeatMs: 10 });
  try {
    await bridge.start();
    await until(() => selections.length > 0);
    assert.equal(bridge.snapshot().activeSessions, 2);
    assert.deepEqual(selections.at(-1), [{ plugin_id: 'example', generation: '1' }]);
    sessions = [session];
    await until(() => bridge.snapshot().activeSessions === 1);
    assert.deepEqual(selections.at(-1), [{ plugin_id: 'example', generation: '1' }]);
  } finally { await bridge.dispose(); }
});

test('重复命令与失败回执均不重放原动作', async () => {
  let executions = 0, acknowledgements = 0;
  const bridge = createDebuggerBridge({ gateway: gateway({
    heartbeat: async () => result({ instance_id: instanceId, active_sessions: [session], targets: [target] }),
    poll: async () => result({ instance_id: instanceId, active_sessions: [session], targets: [target], commands: [command] }),
    acknowledge: async () => { acknowledgements++; throw new Error('网络回执丢失'); },
  }), signal: new AbortController().signal, directory: () => [], select: () => {},
    execute: async () => { executions++; return { observed: true }; }, heartbeatMs: 10 });
  try {
    await bridge.start(); await until(() => bridge.snapshot().unconfirmedReceipts === 1);
    await sleep(35);
    assert.equal(executions, 1); assert.equal(acknowledgements, 1);
  } finally { await bridge.dispose(); }
});

test('等待轮询期间插件换代时撤销旧选择但保持桥连接以登记新代', async () => {
  let generation = '1', beats = 0;
  const selections: string[][] = [];
  const bridge = createDebuggerBridge({ gateway: gateway({
    heartbeat: async () => {
      beats++;
      return result({ instance_id: instanceId, active_sessions: generation === '1' ? [session] : [], targets: [] });
    },
    poll: async () => {
      generation = '2';
      return result({ instance_id: instanceId, active_sessions: [session], targets: [], commands: [] });
    },
  }), signal: new AbortController().signal,
    directory: () => [{ plugin_id: 'example', generation, version: '1.0' }],
    select: targets => {
      if (targets.some(item => item.generation !== generation)) throw new Error('不能选择旧代');
      selections.push(targets.map(item => item.generation ?? ''));
    }, execute: async () => ({}), heartbeatMs: 10 });
  try {
    await bridge.start();
    await until(() => beats >= 2 || bridge.snapshot().state === 'disconnected');
    assert.equal(bridge.snapshot().state, 'connected');
    assert.ok(beats >= 2);
    assert.deepEqual(selections.at(-1), []);
  } finally { await bridge.dispose(); }
});

test('连接中断停止领取，不重新登记实例或自动恢复变更', async () => {
  let registrations = 0, beats = 0;
  const bridge = createDebuggerBridge({ gateway: gateway({
    register: async () => { registrations++; return result({ instance_id: instanceId, plugins: [], active_sessions: 0, idle_ttl_ms: 90000 }); },
    heartbeat: async () => { beats++; throw new Error('连接中断'); },
  }), signal: new AbortController().signal, directory: () => [], select: () => {}, execute: async () => ({}), heartbeatMs: 10 });
  await bridge.start(); await until(() => bridge.snapshot().state === 'disconnected');
  await sleep(30);
  assert.equal(registrations, 1); assert.equal(beats, 1);
  await assert.rejects(bridge.start(), /关闭并重新创建/);
  await bridge.dispose();
});

test('旧实例命令不会被派发，地址预判不接受远端或凭据', async () => {
  let executions = 0;
  const bridge = createDebuggerBridge({ gateway: gateway({
    heartbeat: async () => result({ instance_id: instanceId, active_sessions: [session], targets: [target] }),
    poll: async () => result({ instance_id: instanceId, active_sessions: [session], targets: [target],
      commands: [{ ...command, target: { ...target, instance_id: 'another-instance' } }] }),
  }), signal: new AbortController().signal, directory: () => [], select: () => {},
    execute: async () => { executions++; return {}; }, heartbeatMs: 10 });
  await bridge.start(); await sleep(30); await bridge.dispose();
  assert.equal(executions, 0);
  for (const value of ['http://localhost:7031', 'http://127.0.0.1:7031', 'http://[::1]:7031']) assert.ok(isLoopbackDebuggerAddress(value));
  for (const value of ['http://localhost.evil.test', 'http://127.evil.test', 'http://127.0.0.1.evil.test',
    'http://192.168.1.2:7031', 'http://user:pass@localhost', 'http://localhost?token=x']) assert.equal(isLoopbackDebuggerAddress(value), false);
});

test('父观测域先释放或选择器异常时，关闭仍幂等且不抛业务错误', async () => {
  const lifetime = new AbortController();
  const bridge = createDebuggerBridge({ gateway: gateway(), signal: lifetime.signal,
    directory: () => [], select: () => { throw new Error('父观测域已释放'); }, execute: async () => ({}) });
  await bridge.start();
  lifetime.abort();
  await bridge.dispose(); await bridge.dispose();
  assert.equal(bridge.snapshot().state, 'closed');
});

test('四项回执仍在途时不提前领取第五项，避免回执和轮询的竞态误断线', async () => {
  const release = deferred<void>();
  let executions = 0, polls = 0;
  const pending = Array.from({ length: 5 }, (_, i) => ({ ...command, command_id: `command-${i}` }));
  const bridge = createDebuggerBridge({ gateway: gateway({
    heartbeat: async () => result({ instance_id: instanceId, active_sessions: [session], targets: [target] }),
    poll: async (input) => {
      polls++;
      return result({ instance_id: instanceId, active_sessions: [session], targets: [target], commands: pending.splice(0, input.limit ?? 4) });
    },
    acknowledge: async (input) => {
      await release.promise;
      return result({ command_id: input.command_id, session_id: 'session', state: 'succeeded', timeout_ms: 5000 });
    },
  }), signal: new AbortController().signal, directory: () => [], select: () => {},
    execute: async () => { executions++; return {}; }, heartbeatMs: 10 });
  try {
    await bridge.start(); await until(() => executions === 4); await sleep(20);
    assert.equal(polls, 1); assert.equal(bridge.snapshot().state, 'connected');
    release.resolve(); await until(() => executions === 5);
    assert.equal(bridge.snapshot().state, 'connected');
  } finally { release.resolve(); await bridge.dispose(); }
});
