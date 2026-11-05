import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient } from '../src/services/api/index.ts';
import { createRealtimeClient } from '../src/services/realtime/index.ts';
import type { RealtimeManagerFactory, RealtimeSocket, RealtimeNamespace } from '../src/services/realtime/types.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const envelope = (data: unknown) => ({ log_id: 'realtime-unit-log', data });
class Socket implements RealtimeSocket {
  live = false;
  connects = 0;
  closes = 0;
  hold = false;
  events = new Map<string, Set<(value: unknown) => void>>();
  ready = new Set<() => void>();
  closed = new Set<() => void>();
  errors = new Set<() => void>();
  sent: string[] = [];
  connected = () => this.live;
  connect() { this.live = true; this.connects++; for (const listener of this.ready) listener(); }
  disconnect() { this.live = false; this.closes++; for (const listener of this.closed) listener(); }
  on(event: string, listener: (value: unknown) => void) {
    const set = this.events.get(event) ?? new Set(); this.events.set(event, set); set.add(listener);
    return () => { set.delete(listener); };
  }
  onConnect(listener: () => void) { this.ready.add(listener); return () => { this.ready.delete(listener); }; }
  onDisconnect(listener: () => void) { this.closed.add(listener); return () => { this.closed.delete(listener); }; }
  onError(listener: () => void) { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  send(event: string, _value: unknown, reply: (value: unknown) => void) {
    this.sent.push(event); if (!this.hold) reply(envelope({ accepted: true }));
  }
  event(event: string, value: unknown) { for (const listener of this.events.get(event) ?? []) listener(value); }
}
function fixture(status = 200) {
  const lifetime = new AbortController(), sockets = new Map<RealtimeNamespace, Socket>();
  let factories = 0, disposals = 0, requests = 0;
  const api = createApiClient({ baseUrl: 'http://127.0.0.1:7031',
    transport: async () => {
      requests++;
      return new Response(JSON.stringify(status === 200 ? envelope({ protocol_version: 1,
        path: '/api/v2/realtime/socket.io', namespaces: [{ name: '/debugger', local_only: true }, { name: '/tasks', local_only: false }] })
        : { log_id: 'old-host-log', error: { code: 'not_found', message: '旧宿主缺少此能力' } }),
      { status, headers: { 'content-type': 'application/json' } });
    } });
  const factory: RealtimeManagerFactory = async () => {
    factories++;
    return { socket(namespace) { const socket = new Socket(); sockets.set(namespace, socket); return socket; },
      dispose() { disposals++; for (const socket of sockets.values()) socket.disconnect(); } };
  };
  const realtime = createRealtimeClient({ baseUrl: 'http://127.0.0.1:7031', client: api,
    signal: lifetime.signal, factory });
  return { realtime, lifetime, sockets, counts: () => ({ factories, disposals, requests }) };
}

test('多消费者共用管理器，正常空闲一分钟不再发送HTTP或心跳，最后租约释放资源', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const first = f.realtime.acquire('/tasks'), second = f.realtime.acquire('/tasks'), debug = f.realtime.acquire('/debugger');
  await Promise.all([first.supported, second.supported, debug.supported]);
  assert.equal(f.counts().factories, 1); assert.equal(f.counts().requests, 1);
  assert.equal(f.sockets.get('/tasks')?.connects, 1);
  context.mock.timers.tick(60000); await settle();
  assert.equal(f.counts().requests, 1);
  assert.deepEqual([...f.sockets.values()].flatMap(socket => socket.sent), []);
  first.release(); assert.equal(second.connected(), true);
  second.release(); assert.equal(debug.connected(), true);
  debug.release(); await settle();
  assert.equal(f.counts().disposals, 1);
  f.realtime.dispose(); context.mock.timers.tick(60000); await settle();
  assert.equal(f.counts().factories, 1);
});

test('任务消费者错误局部隔离，释放后不再收到任何通知', async () => {
  const f = fixture(); let seen = 0;
  const bad = f.realtime.subscribeTasks(() => { throw new Error('业务观察者错误'); });
  const good = f.realtime.subscribeTasks(state => { if (state.state === 'changed') seen++; });
  await settle(); await settle();
  const socket = f.sockets.get('/tasks'); assert.ok(socket);
  socket.event('tasks:changed', envelope({ revision: '3', reset: false }));
  assert.equal(seen, 1);
  good(); bad(); socket.event('tasks:changed', envelope({ revision: '4', reset: false }));
  assert.equal(seen, 1); f.realtime.dispose();
});

test('超过待确认容量的消息不发送，超时和释放只结束等待不重放', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), channel = f.realtime.acquire('/debugger'); await channel.supported;
  const socket = f.sockets.get('/debugger'); assert.ok(socket); socket.hold = true;
  const pending = Array.from({ length: 8 }, () => channel.request('bridge:ack', {}, f.lifetime.signal));
  const results = Promise.allSettled(pending);
  await assert.rejects(channel.request('bridge:ack', {}, f.lifetime.signal), { code: 'realtime_capacity' });
  assert.equal(socket.sent.length, 8);
  context.mock.timers.tick(5000);
  assert.ok((await results).every(result => result.status === 'rejected'));
  socket.disconnect(); socket.connect(); await settle(); assert.equal(socket.sent.length, 8);
  channel.release(); f.realtime.dispose();
});

test('只有明确旧宿主能力缺失才兼容，库加载失败不阻止独立HTTP调用', async () => {
  const old = fixture(404), channel = old.realtime.acquire('/debugger');
  assert.equal(await channel.supported, false); assert.equal(old.counts().factories, 0); channel.release(); old.realtime.dispose();
  const f = fixture(); const broken = createRealtimeClient({ baseUrl: 'http://127.0.0.1',
    signal: f.lifetime.signal, client: createApiClient({ baseUrl: 'http://127.0.0.1',
      transport: async () => new Response(JSON.stringify(envelope({ protocol_version: 1,
        path: '/api/v2/realtime/socket.io', namespaces: ['/debugger', '/tasks'] }))) }),
    factory: async () => { throw new Error('库无法加载'); } });
  const bad = broken.acquire('/tasks'); await assert.rejects(bad.supported, /库无法加载/);
  const healthy = f.realtime.acquire('/tasks'); assert.equal(await healthy.supported, true);
  bad.release(); healthy.release(); broken.dispose(); f.realtime.dispose();
});

test('超大消息在发送前拒绝，取消释放待确认容量，调试通道异常不撤销任务消费者', async () => {
  const f = fixture(), debug = f.realtime.acquire('/debugger'); let notices = 0;
  const stop = f.realtime.subscribeTasks(change => { if (change.state === 'changed') notices++; });
  await debug.supported; await settle();
  const debugSocket = f.sockets.get('/debugger'), taskSocket = f.sockets.get('/tasks');
  assert.ok(debugSocket); assert.ok(taskSocket);
  await assert.rejects(debug.request('bridge:ack', { text: 'x'.repeat(1024 * 1024 + 16 * 1024) }, f.lifetime.signal),
    { code: 'realtime_message_too_large' });
  assert.equal(debugSocket.sent.length, 0);
  debugSocket.hold = true; const caller = new AbortController();
  const pending = debug.request('bridge:ack', {}, caller.signal); caller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  debugSocket.hold = false; await debug.request('bridge:ack', {}, f.lifetime.signal);
  for (const error of debugSocket.errors) error();
  taskSocket.event('tasks:changed', envelope({ revision: '5', reset: false }));
  assert.equal(notices, 1); debug.release();
  assert.equal(taskSocket.connected(), true);
  taskSocket.event('tasks:changed', envelope({ revision: '6', reset: false }));
  assert.equal(notices, 2); stop(); f.realtime.dispose();
});
