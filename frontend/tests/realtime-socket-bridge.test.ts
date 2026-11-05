import assert from 'node:assert/strict';
import test from 'node:test';
import { createSocketDebuggerBridge } from '../src/features/debugger/models/socket-bridge.ts';
import { createDebuggerBridge } from '../src/features/debugger/models/bridge.ts';
import { bounded } from '../src/features/debugger/utils/wait.ts';
import { createApiClient, createDebuggerGateway } from '../src/services/api/index.ts';
import type { RealtimeChannel, RealtimeState } from '../src/services/realtime/index.ts';
import type { BridgeCommand, DebuggerBridgeOptions } from '../src/features/debugger/types/index.ts';
import type { JsonValue } from '../src/plugin-sdk/index.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let finish: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => { finish = resolve; });
  return { promise, resolve(value: T) { assert.ok(finish); finish(value); } };
}
const target = { target_kind: 'browser', instance_id: 'page-one', plugin_id: 'sample', generation: 'gen-one', version: '1' } satisfies BridgeCommand['target'];
const status = { instance_id: 'page-one', active_sessions: [], targets: [target] };
const openResult = (commands: unknown[] = []) => ({ instance_id: 'page-one', resume_key: 'resume-one', status, commands });
const command = (id = 'cmd-one'): BridgeCommand => ({ command_id: id, session_id: 'session-one', target,
  tool: 'inspect', parameters: {}, remaining_ms: 10000 });
const receipt = (id: string) => ({ command_id: id, session_id: 'session-one', state: 'succeeded', timeout_ms: 10000 });

class Channel implements RealtimeChannel {
  supported = Promise.resolve(true);
  live = true;
  released = false;
  states = new Set<(state: RealtimeState) => void>();
  events = new Map<string, Set<(value: unknown) => void>>();
  calls: { event: string; value: unknown }[] = [];
  respond: (event: string, value: unknown) => unknown | Promise<unknown> = (event, value) => {
    if (event === 'bridge:open') return openResult();
    if (event === 'bridge:directory') return status;
    if (event === 'bridge:ack') {
      assert.ok(value && typeof value === 'object' && 'command_id' in value && typeof value.command_id === 'string');
      return receipt(value.command_id);
    }
    return { accepted: true };
  };
  connected = () => this.live && !this.released;
  subscribe(listener: (state: RealtimeState) => void) {
    this.states.add(listener); listener({ state: this.live ? 'ready' : 'unavailable', revision: null, reset: true });
    return () => { this.states.delete(listener); };
  }
  on(event: string, listener: (value: unknown) => void) {
    const set = this.events.get(event) ?? new Set(); this.events.set(event, set); set.add(listener);
    return () => { set.delete(listener); };
  }
  request(event: string, value: unknown, signal: AbortSignal) {
    this.calls.push({ event, value });
    return bounded(Promise.resolve().then(() => this.respond(event, value)), signal);
  }
  reconnect() { this.state(true); }
  release() { this.released = true; }
  state(live: boolean) {
    this.live = live;
    for (const listener of [...this.states]) listener({ state: live ? 'ready' : 'unavailable', revision: null, reset: true });
  }
  batch(commands: BridgeCommand[]) {
    for (const listener of this.events.get('bridge:batch') ?? [])
      listener({ log_id: 'unit-debug-log', data: { ...status, commands } });
  }
  sent(event: string) { return this.calls.filter(call => call.event === event); }
}
function fixture(execute: DebuggerBridgeOptions['execute'] = async () => ({ ok: true })) {
  const channel = new Channel(), lifetime = new AbortController();
  let http = 0;
  let plugins = [{ plugin_id: 'sample', generation: 'gen-one', version: '1' }];
  const options: DebuggerBridgeOptions = {
    gateway: createDebuggerGateway(createApiClient({ baseUrl: 'http://127.0.0.1:7031', transport: async () => {
      http++; throw new Error('实时调试测试不应调用HTTP桥');
    } })), signal: lifetime.signal, directory: () => plugins, select: () => {}, execute,
  };
  return { channel, lifetime, options, bridge: createSocketDebuggerBridge(options, channel),
    http: () => http, changeDirectory() { plugins = [{ plugin_id: 'sample', generation: 'gen-two', version: '2' }]; } };
}

test('登记一次，目录只随变化发送；健康空闲一分钟不请求HTTP，释放后没有订阅或定时恢复', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.bridge.start();
  assert.equal(f.channel.sent('bridge:open').length, 1);
  await f.bridge.directoryChanged(); assert.equal(f.channel.sent('bridge:directory').length, 0);
  f.changeDirectory(); await f.bridge.directoryChanged(); await f.bridge.directoryChanged();
  assert.equal(f.channel.sent('bridge:directory').length, 1);
  const before = f.channel.calls.length;
  context.mock.timers.tick(60000); await settle();
  assert.equal(f.channel.calls.length, before); assert.equal(f.http(), 0);
  await f.bridge.dispose(); assert.equal(f.channel.released, true); assert.equal(f.channel.states.size, 0);
  const closed = f.channel.calls.length;
  context.mock.timers.tick(60000); f.channel.state(true); await settle();
  assert.equal(f.channel.calls.length, closed); assert.equal(f.bridge.snapshot().state, 'closed');
});

test('重复批次只执行一次；发送第一份回执期间完成的另一动作也提交结果', async () => {
  const second = deferred<JsonValue>(), ack = deferred<unknown>(); let executions = 0;
  const f = fixture(async current => { executions++; return current.command_id === 'cmd-two' ? second.promise : { ok: true }; });
  const original = f.channel.respond;
  f.channel.respond = (event, value) => event === 'bridge:ack' && f.channel.sent('bridge:ack').length === 1
    ? ack.promise : original(event, value);
  await f.bridge.start();
  f.channel.batch([command(), command('cmd-two')]); await settle();
  f.channel.batch([command()]); assert.equal(executions, 2);
  second.resolve({ ok: true }); await settle(); ack.resolve(receipt('cmd-one')); await settle(); await settle();
  assert.equal(f.channel.sent('bridge:ack').length, 2); assert.equal(executions, 2);
  await f.bridge.dispose();
});

test('动作完成但回执丢失时先恢复核对，同一命令只补交结果而不重放动作', async () => {
  const lost = deferred<unknown>(); let executions = 0, lose = true;
  const f = fixture(async () => { executions++; return { ok: true }; }); const original = f.channel.respond;
  f.channel.respond = (event, value) => event === 'bridge:ack' && lose ? lost.promise : original(event, value);
  await f.bridge.start(); f.channel.batch([command()]); await settle();
  assert.equal(f.channel.sent('bridge:ack').length, 1);
  f.channel.state(false); lose = false; f.channel.state(true); await settle(); await settle();
  f.channel.batch([command()]); await settle();
  assert.equal(executions, 1); assert.equal(f.channel.sent('bridge:open').length, 2);
  assert.equal(f.channel.sent('bridge:ack').length, 2);
  assert.deepEqual(f.channel.sent('bridge:open')[1]?.value, { instance_id: 'page-one', resume_key: 'resume-one',
    plugins: [{ plugin_id: 'sample', generation: 'gen-one', version: '1' }], inflight: ['cmd-one'] });
  lost.resolve(receipt('cmd-one')); await settle(); assert.equal(f.bridge.snapshot().state, 'connected');
  await f.bridge.dispose();
});

test('登记期间断线撤销旧等待，晚到旧回调不污染新代', async () => {
  const old = deferred<unknown>(); const f = fixture(); let opening = 0;
  f.channel.respond = event => event === 'bridge:open' ? (++opening === 1 ? old.promise : openResult()) : { accepted: true };
  const starting = f.bridge.start(); await settle();
  f.channel.state(false); f.channel.state(true); await settle(); await settle();
  await starting; assert.equal(opening, 2); assert.equal(f.bridge.snapshot().instanceId, 'page-one');
  old.resolve({ ...openResult(), instance_id: 'stale-page' }); await settle();
  assert.equal(f.bridge.snapshot().instanceId, 'page-one'); assert.equal(f.bridge.snapshot().state, 'connected');
  await f.bridge.dispose();
});

test('恢复发现原回执已经终态时不再补交，重复旧批次仍不会重放', async () => {
  const lost = deferred<unknown>(); let executions = 0, resumed = false;
  const f = fixture(async () => { executions++; return { ok: true }; }); const original = f.channel.respond;
  f.channel.respond = (event, value) => {
    if (event === 'bridge:ack') return lost.promise;
    if (event === 'bridge:open' && resumed) return openResult([{ command_id: 'cmd-one', session_id: 'session-one', state: 'succeeded', response: null }]);
    return original(event, value);
  };
  await f.bridge.start(); f.channel.batch([command()]); await settle();
  f.channel.state(false); resumed = true; f.channel.state(true); await settle(); await settle();
  f.channel.batch([command()]); await settle();
  assert.equal(executions, 1); assert.equal(f.channel.sent('bridge:ack').length, 1);
  await f.bridge.dispose();
});

test('原动作预算或卸载结束后收敛等待，不重新派发，晚到结果不写回', async () => {
  const result = deferred<JsonValue>(); let executions = 0;
  const f = fixture(async () => { executions++; return result.promise; });
  await f.bridge.start(); f.channel.batch([{ ...command(), remaining_ms: 10 }]);
  await new Promise<void>(resolve => setTimeout(resolve, 30)); await settle();
  const ack = f.channel.sent('bridge:ack')[0]?.value;
  assert.ok(ack && typeof ack === 'object' && 'success' in ack); assert.equal(ack.success, false);
  assert.equal(executions, 1); result.resolve({ ok: true }); await settle();
  assert.equal(f.channel.sent('bridge:ack').length, 1);
  f.channel.batch([command('pending-on-close')]); await settle(); await f.bridge.dispose();
  const calls = f.channel.calls.length; f.channel.batch([command('after-close')]); await settle();
  assert.equal(f.channel.calls.length, calls); assert.equal(f.bridge.snapshot().state, 'closed');
});

test('能力查询尚未返回时释放桥，迟到支持结果不能创建新桥或HTTP轮询', async () => {
  const f = fixture(); await f.bridge.dispose();
  const supported = deferred<boolean>(), channel = new Channel(); channel.supported = supported.promise;
  const bridge = createDebuggerBridge({ ...f.options, realtime: { acquire: () => channel, subscribeTasks: () => () => {}, dispose: () => {} } });
  const starting = bridge.start(); await bridge.dispose(); supported.resolve(true); await starting; await settle();
  assert.equal(channel.released, true); assert.equal(channel.states.size, 0); assert.equal(channel.calls.length, 0);
  assert.equal(f.http(), 0); assert.equal(bridge.snapshot().state, 'closed');
});

test('登记可用但回执持续失败时恢复窗口仍在一分钟内结束，不循环续期或重放', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let executions = 0;
  const f = fixture(async () => { executions++; return { ok: true }; }); const original = f.channel.respond;
  f.channel.respond = (event, value) => {
    if (event === 'bridge:ack') throw new Error('回执暂时不可用');
    return original(event, value);
  };
  await f.bridge.start(); f.channel.batch([command()]); await settle();
  for (let count = 0; count < 15; count++) { context.mock.timers.tick(5000); await settle(); await settle(); }
  assert.equal(f.bridge.snapshot().state, 'disconnected'); assert.equal(executions, 1);
  assert.ok(f.channel.sent('bridge:open').length <= 14);
  const before = f.channel.calls.length; context.mock.timers.tick(60000); await settle();
  assert.equal(f.channel.calls.length, before); await f.bridge.dispose();
});

test('登记暂忙在原启动期限内恢复时启动等待随之完成，已关闭桥不能再次启动', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const original = f.channel.respond; let opens = 0;
  f.channel.respond = (event, value) => {
    if (event === 'bridge:open' && ++opens === 1) throw new Error('登记暂忙');
    return original(event, value);
  };
  const starting = f.bridge.start(); await settle();
  context.mock.timers.tick(1000); await settle(); await starting;
  assert.equal(f.bridge.snapshot().state, 'connected');
  await f.bridge.dispose(); await assert.rejects(f.bridge.start(), /已关闭/);
});
