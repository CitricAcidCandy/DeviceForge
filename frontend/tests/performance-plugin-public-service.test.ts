import './official-business-imports.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { Dispose, HostContext, HostResult, Job, JsonValue, ServiceContribution } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { deferred, signal } from './fixtures.ts';

const { default: createPerformancePlugin } = await import('../plugins/performance/src/index.ts');
const { PerformanceJobFailure, PerformanceWaitFailure } = await import('../plugins/performance/src/performance/index.ts');

const sessionId = '11111111-1111-4111-8111-111111111111';
const startInput = { target: { device_id: 'emulator-5554', package: 'com.example.app' }, interval_ms: 1000, duration_secs: 60 };
const session = { id: sessionId, request: startInput, revision: 1, state: 'running', samples: 0,
  started_at: 1000, updated_at: 1001, error: null };
const capabilities = { metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib'], fps: false,
  source: 'plugin.synthetic', scope: 'main_process', max_samples: 3600, sample_timeout_ms: 10000 };

function result(operation: string): JsonValue {
  if (operation.endsWith('.capabilities')) return capabilities;
  if (operation.endsWith('.samples')) return { session, readings: [], next_after: 0 };
  if (operation.endsWith('.list')) return { sessions: [session], next_after_id: sessionId };
  return session;
}
function reply(operation: string, value = result(operation), logId = 'service-log'): HostResult<Job> {
  return { data: { id: 'performance-job', operation, status: 'succeeded', result: value, error: null }, logId };
}
type Gateway = Pick<HostContext, 'submit' | 'getJob'>;
async function fixture(gateway: Partial<Gateway> = {}, id = 'deviceforge_performance') {
  const owner = new AbortController(), disposers: Dispose[] = [];
  const registry = createWorkspaceRegistry();
  const services = new Map<string, ServiceContribution>();
  const calls: { readonly operation: string; readonly input: JsonValue; readonly signal: AbortSignal }[] = [];
  const queries: { readonly id: string; readonly signal: AbortSignal }[] = [];
  let directoryReads = 0, cancels = 0;
  const unavailable = async (): Promise<never> => { throw new Error('本单元不应请求未装配能力'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal,
    listOperations: async () => { directoryReads++; return { data: [], logId: 'directory-log' }; },
    subscribeOperations: () => () => {},
    submit: async (operation, input, current) => {
      calls.push({ operation, input, signal: current });
      return gateway.submit ? gateway.submit(operation, input, current) : reply(operation);
    },
    getJob: async (jobId, current) => {
      queries.push({ id: jobId, signal: current });
      return gateway.getJob ? gateway.getJob(jobId, current) : unavailable();
    },
    cancelJob: async () => { cancels++; return unavailable(); },
    onDispose(dispose) { disposers.push(dispose); return dispose; },
    ui: registry.access({ pluginId: id, generation: 1, signal: owner.signal }),
    extensions: {
      catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: unavailable, callService: unavailable, subscribeEvent: () => () => {}, emitEvent() {},
      getState: () => undefined, setState() {}, subscribeState: () => () => {},
      register(contributions) {
        for (const service of contributions.services ?? []) {
          assert.ok(service.id.startsWith(`${id}.`));
          assert.equal(service.id.startsWith('host.'), false);
          services.set(service.id, service);
        }
        return () => { for (const service of contributions.services ?? []) if (services.get(service.id) === service) services.delete(service.id); };
      },
    },
  };
  await createPerformancePlugin({ id, version: '0.1.0', apiVersion: 2 }).activate?.(context);
  function service() {
    const entry = services.get(`${id}.api`);
    assert.ok(entry, '插件应登记自身命名空间的性能服务');
    assert.equal(entry.version, '1');
    return entry;
  }
  return { context, owner, services, calls, queries, counts: () => ({ directoryReads, cancels }), service,
    call: (value: JsonValue, current = signal()) => service().invoke(value, context, current),
    async dispose() { owner.abort(); for (const dispose of disposers.reverse()) await dispose(); registry.dispose(); } };
}

test('性能插件只登记自身版本服务，激活和无调用卸载不请求目录、不联网或开始会话', async () => {
  const f = await fixture({}, 'custom_performance');
  try {
    assert.equal(f.service().id, 'custom_performance.api');
    assert.equal(f.calls.length, 0);
    assert.equal(f.queries.length, 0);
    assert.deepEqual(f.counts(), { directoryReads: 0, cancels: 0 });
  } finally { await f.dispose(); }
  assert.equal(f.calls.length, 0);
  assert.equal(f.services.size, 0);
});

test('性能插件八动作沿已迁模型派发并保留成功日志，服务模型不改变UI实例', async () => {
  const f = await fixture();
  try {
    const before = f.context.ui?.snapshot();
    const requests: JsonValue[] = [
      { action: 'start', input: startInput }, { action: 'inspect', input: { session_id: sessionId } },
      { action: 'pause', input: { session_id: sessionId } }, { action: 'resume', input: { session_id: sessionId } },
      { action: 'stop', input: { session_id: sessionId } }, { action: 'samples', input: { session_id: sessionId, after: 0, limit: 2 } },
      { action: 'list', input: { limit: 3 } }, { action: 'capabilities' },
    ];
    for (const request of requests) assert.equal((await f.call(request)).logId, 'service-log');
    assert.deepEqual(f.calls.map((entry) => entry.operation), ['start', 'inspect', 'pause', 'resume', 'stop', 'samples', 'list', 'capabilities'].map((action) => `android.performance.${action}`));
    assert.deepEqual(f.calls[6]?.input, { after_id: null, limit: 3 });
    assert.equal(f.context.ui?.snapshot(), before);
    assert.equal(f.queries.length, 0);
  } finally { await f.dispose(); }
  assert.equal(f.calls.length, 8);
});

test('性能插件拒绝未知字段、越界参数、循环和非有限JSON及16KiB输入，拒绝前不提交任务', async () => {
  const f = await fixture();
  const cyclic: JsonValue[] = [];
  cyclic.push(cyclic);
  const invalid: JsonValue[] = [null, [], cyclic,
    { action: 'unknown' }, { action: 'capabilities', input: {} }, { action: 'capabilities', extra: true },
    { action: 'start', input: { ...startInput, source: 'guessed-source' } },
    { action: 'start', input: { ...startInput, interval_ms: 49 } },
    { action: 'start', input: { ...startInput, duration_secs: 3601 } },
    { action: 'inspect', input: { session_id: 'task-id' } },
    { action: 'pause', input: { session_id: sessionId, revision: 1 } },
    { action: 'samples', input: { session_id: sessionId, after: -1, limit: 2 } },
    { action: 'samples', input: { session_id: sessionId, after: 0, limit: 101 } },
    { action: 'list', input: { after_id: [], limit: 1 } },
    { action: 'list', input: { after_id: 'task-id', limit: 1 } },
    { action: 'list', input: { limit: NaN } }, { action: 'start', input: null }];
  try {
    for (const request of invalid) await assert.rejects(f.call(request),
      (error: unknown) => error instanceof HostError && error.kind === 'protocol' && error.logId === null);
    await assert.rejects(f.call({ action: 'capabilities', extra: '字'.repeat(6000) }),
      (error: unknown) => error instanceof HostError && error.code === 'performance_service_limit' && error.logId === null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.queries.length, 0);
  } finally { await f.dispose(); }
});

test('性能插件保留HTTP和失败任务的本次日志、空日志与失败原文，不借旧日志阻止新调用', async () => {
  const httpFailure = new HostError('http', 'performance_unavailable', '性能来源尚不可用', 'http-log', 503, '2');
  let attempt = 0;
  const f = await fixture({ submit: async (operation) => {
    attempt++;
    if (attempt === 1) throw httpFailure;
    if (attempt === 2 || attempt === 3) return { data: { id: 'failed-job', operation, status: 'failed', result: null,
      error: '本次性能来源已撤销' }, logId: attempt === 2 ? 'failed-log' : null };
    return reply(operation);
  } });
  try {
    await assert.rejects(f.call({ action: 'capabilities' }), (error: unknown) => error instanceof HostError &&
      error.code === 'performance_unavailable' && error.logId === 'http-log' && error.status === 503 && error.retryAfter === '2');
    for (const logId of ['failed-log', null]) await assert.rejects(f.call({ action: 'inspect', input: { session_id: sessionId } }),
      (error: unknown) => error instanceof PerformanceJobFailure && error.message === '本次性能来源已撤销' && error.logId === logId && error.job.id === 'failed-job');
    assert.equal((await f.call({ action: 'inspect', input: { session_id: sessionId } })).logId, 'service-log');
    assert.equal(f.calls.length, 4);
  } finally { await f.dispose(); }
});

test('性能插件拒绝不兼容或超过4MiB的业务结果并保留结果本次日志', async () => {
  let attempt = 0;
  const f = await fixture({ submit: async (operation) => {
    attempt++;
    return reply(operation, attempt === 1 ? { result: session, artifacts: [] } :
      { ...session, error: 'x'.repeat(4 * 1024 * 1024) }, attempt === 1 ? 'decode-log' : 'large-log');
  } });
  try {
    await assert.rejects(f.call({ action: 'inspect', input: { session_id: sessionId } }),
      (error: unknown) => error instanceof HostError && error.code === 'invalid_performance_result' && error.logId === 'decode-log');
    await assert.rejects(f.call({ action: 'inspect', input: { session_id: sessionId } }),
      (error: unknown) => error instanceof HostError && error.code === 'performance_service_limit' && error.logId === 'large-log');
  } finally { await f.dispose(); }
});

test('性能插件调用预先取消不提交，已接受任务取消只撤等待、不重放或猜测停止会话', async () => {
  const queried = deferred<void>(), pending = deferred<HostResult<Job>>();
  let attempt = 0;
  const f = await fixture({ submit: async (operation) => {
    attempt++;
    const response = reply(operation);
    return attempt === 1 ? { ...response, data: { ...response.data, status: 'queued', result: null } } : response;
  }, getJob: async () => { queried.resolve(); return pending.promise; } });
  const caller = new AbortController(), preCancelled = new AbortController();
  preCancelled.abort();
  try {
    await assert.rejects(f.call({ action: 'capabilities' }, preCancelled.signal));
    assert.equal(f.calls.length, 0);
    const waiting = f.call({ action: 'inspect', input: { session_id: sessionId } }, caller.signal);
    const rejected = assert.rejects(waiting, (error: unknown) => error instanceof PerformanceWaitFailure &&
      error.job.id === 'performance-job' && error.logId === 'service-log');
    await queried.promise;
    caller.abort();
    await rejected;
    assert.equal(f.queries[0]?.signal.aborted, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.counts().cancels, 0);
    pending.resolve(reply('android.performance.inspect', { ...session, revision: 9 }, 'late-log'));
    assert.equal((await f.call({ action: 'inspect', input: { session_id: sessionId } })).logId, 'service-log');
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every((entry) => entry.operation === 'android.performance.inspect'));
  } finally { pending.resolve(reply('android.performance.inspect')); await f.dispose(); }
});

test('性能插件卸载撤销在途调用和旧服务，晚到结果不复活，重新启用新代可独立调用', async () => {
  const queried = deferred<void>(), pending = deferred<HostResult<Job>>();
  const old = await fixture({ submit: async (operation) => {
    const response = reply(operation);
    return { ...response, data: { ...response.data, status: 'queued', result: null } };
  }, getJob: async () => { queried.resolve(); return pending.promise; } });
  let next: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const captured = old.service();
    const waiting = old.call({ action: 'inspect', input: { session_id: sessionId } });
    const rejected = assert.rejects(waiting, (error: unknown) => error instanceof PerformanceWaitFailure ||
      error instanceof HostError && error.kind === 'cancelled');
    await queried.promise;
    await old.dispose();
    await rejected;
    assert.equal(old.services.size, 0);
    assert.equal(old.queries[0]?.signal.aborted, true);
    await assert.rejects(captured.invoke({ action: 'capabilities' }, old.context, signal()),
      (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
    pending.resolve(reply('android.performance.inspect', { ...session, revision: 99 }, 'old-late-log'));
    next = await fixture();
    assert.equal(next.calls.length, 0);
    const response = await next.call({ action: 'inspect', input: { session_id: sessionId } });
    assert.deepEqual(response, { data: session, logId: 'service-log' });
    assert.equal(old.calls.length, 1);
    assert.equal(next.calls.length, 1);
    assert.equal(old.counts().cancels, 0);
  } finally { pending.resolve(reply('android.performance.inspect')); await next?.dispose(); await old.dispose(); }
});
