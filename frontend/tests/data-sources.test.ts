import assert from 'node:assert/strict';
import test from 'node:test';
import { createDataSourceRegistry, scopedDataAccess } from '../src/plugins/data-sources/index.ts';
import type { DataSourceServices } from '../src/plugins/data-sources/index.ts';
import { HostError } from '../src/plugin-sdk/models.ts';
import type { Dispose, HostResult, JsonValue } from '../src/plugin-sdk/models.ts';
import type { DataAccess, DataSourceDefinition } from '../src/plugin-sdk/data-sources.ts';
import { deferred, signal } from './fixtures.ts';

function resources() {
  const releases = new Set<Dispose>();
  return {
    track(release: Dispose): Dispose {
      let disposed = false;
      const tracked = () => {
        if (disposed) return;
        disposed = true; releases.delete(tracked); return release();
      };
      releases.add(tracked); return tracked;
    },
    dispose() { for (const release of [...releases]) void release(); },
  };
}
const definition: DataSourceDefinition = {
  id: 'provider.settings', version: '1', title: '插件设置', readOnly: false, applyPolicy: 'immediate',
  schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  read: { id: 'provider.read', version: '1' }, write: { id: 'provider.write', version: '1' },
};
function fixture() {
  const registry = createDataSourceRegistry();
  const controller = new AbortController();
  const providerResources = resources();
  const calls: { id: string; input: JsonValue }[] = [];
  let value: JsonValue = { name: '原值' }, revision = 'r1';
  const services: DataSourceServices = {
    async call(ref, input) {
      calls.push({ id: ref.id, input });
      if (ref.id === 'provider.write') {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || input.expectedRevision !== revision)
          throw new HostError('http', 'revision_conflict', '数据已被修改', 'conflict-log', 409);
        value = input.value ?? null; revision = 'r2';
      }
      return { data: { value, revision }, logId: 'data-log' };
    },
  };
  const provider = registry.access({ pluginId: 'provider', generation: 1, signal: controller.signal }, services, providerResources.track);
  const consumerResources = resources();
  const consumer = registry.access({ pluginId: 'consumer', generation: 1, signal: signal() }, services, consumerResources.track);
  return { registry, controller, provider, consumer, calls, services, providerResources, consumerResources };
}

test('独立数据源通过精确服务读取和写入，保留真实修订、日志及生效策略', async () => {
  const f = fixture();
  f.provider.register(definition);
  const initial = await f.consumer.read(definition, signal());
  assert.deepEqual(initial, { data: { value: { name: '原值' }, revision: 'r1' }, logId: 'data-log' });
  const result = await f.consumer.write(definition, { value: { name: '新值' }, expectedRevision: initial.data.revision }, signal());
  assert.deepEqual(result, { data: { value: { name: '新值' }, revision: 'r2' }, logId: 'data-log' });
  assert.deepEqual(f.calls, [{ id: 'provider.read', input: {} }, { id: 'provider.write', input: { value: { name: '新值' }, expectedRevision: 'r1' } }]);
  assert.equal(f.consumer.catalog()[0]?.applyPolicy, 'immediate');
});

test('目录稳定、可序列化且不能修改登记模式或服务引用', () => {
  const f = fixture();
  const mutable = structuredClone(definition);
  f.provider.register(mutable);
  const before = f.consumer.catalog();
  assert.equal(f.consumer.catalog(), before);
  assert.ok(Object.isFrozen(before));
  assert.ok(Object.isFrozen(before[0]?.read));
  assert.deepEqual(before[0]?.provider, { pluginId: 'provider', generation: 1 });
  assert.equal(JSON.stringify(before).includes('function'), false);
  Object.assign(mutable.read, { id: 'provider.hijack' });
  assert.equal(before[0]?.read.id, 'provider.read');
});

test('数据持久性可选但不得猜测，合法声明按原值保留', () => {
  const f = fixture();
  const release = f.provider.register(definition);
  assert.equal(f.consumer.catalog()[0]?.persistence, undefined);
  void release();
  f.provider.register({ ...definition, persistence: 'persistent' });
  assert.equal(f.consumer.catalog()[0]?.persistence, 'persistent');
});

test('提供者仅可登记自身命名空间，重复标识和无效策略明确拒绝', () => {
  const f = fixture();
  assert.throws(() => f.consumer.register(definition), /命名空间/);
  f.provider.register(definition);
  assert.throws(() => f.provider.register(definition), /已登记/);
  assert.throws(() => f.provider.register({ ...definition, id: 'provider.other', readOnly: true }), /只读/);
  const { write: _write, ...withoutWrite } = definition;
  assert.throws(() => f.provider.register({ ...withoutWrite, id: 'provider.other' }), /变更服务/);
});

test('缺失数据源和版本不匹配不能隐式调用，新登记后即可读取', async () => {
  const f = fixture();
  await assert.rejects(f.consumer.read(definition, signal()), /不可用/);
  f.provider.register(definition);
  await assert.rejects(f.consumer.read({ id: definition.id, version: '1.0' }, signal()), /不可用/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.consumer.read(definition, signal())).data.revision, 'r1');
});

test('只读数据源禁止写入，模式错误在执行前拒绝', async () => {
  const f = fixture();
  const { write: _write, ...readOnly } = definition;
  f.provider.register({ ...readOnly, readOnly: true, applyPolicy: 'reload' });
  await assert.rejects(f.consumer.write(definition, { value: {}, expectedRevision: 'r1' }, signal()), (error: unknown) => error instanceof HostError && error.code === 'data_source_read_only');
  assert.equal(f.calls.length, 0);
  f.controller.abort();
  const next = f.registry.access({ pluginId: 'provider', generation: 2, signal: signal() }, f.services, f.providerResources.track);
  next.register(definition);
  await assert.rejects(f.consumer.write(definition, { value: { name: 3 }, expectedRevision: 'r1' }, signal()), /不符合/);
  await assert.rejects(f.consumer.write(definition, { value: { name: '有效' }, expectedRevision: '' }, signal()), /修订/);
  assert.equal(f.calls.length, 0);
});

test('冲突保留原错误和调用方草稿，结果未知不重放服务', async () => {
  const f = fixture();
  f.provider.register(definition);
  const draft = { value: { name: '保留草稿' }, expectedRevision: 'old' };
  await assert.rejects(f.consumer.write(definition, draft, signal()), (error: unknown) => error instanceof HostError && error.code === 'revision_conflict' && error.logId === 'conflict-log' && error.status === 409);
  assert.deepEqual(draft, { value: { name: '保留草稿' }, expectedRevision: 'old' });
  const unknown = new HostError('network', 'write_result_unknown', '结果尚未确认', 'unknown-log');
  let count = 0;
  const consumer = f.registry.access({ pluginId: 'another', generation: 1, signal: signal() }, { call: async () => { count++; throw unknown; } }, f.consumerResources.track);
  await assert.rejects(consumer.write(definition, { ...draft, expectedRevision: 'r1' }, signal()), (error: unknown) => error === unknown);
  assert.equal(count, 1);
});

test('数据服务输出须含有效修订并符合登记模式', async () => {
  const f = fixture();
  f.provider.register(definition);
  let output: JsonValue = { value: { name: '名称' } };
  const consumer = f.registry.access({ pluginId: 'observer', generation: 1, signal: signal() }, { call: async () => ({ data: output, logId: 'bad-log' }) }, f.consumerResources.track);
  await assert.rejects(consumer.read(definition, signal()), (error: unknown) => error instanceof HostError && error.code === 'invalid_data_snapshot' && error.logId === 'bad-log');
  output = { value: { name: 9 }, revision: 'r1' };
  await assert.rejects(consumer.read(definition, signal()), (error: unknown) => error instanceof HostError && error.code === 'data_source_output_invalid');
});

test('提供者卸载立即撤销目录，旧释放不能删除新代数据源', () => {
  const f = fixture();
  const release = f.provider.register(definition);
  const first = f.consumer.catalog();
  f.controller.abort();
  assert.equal(f.consumer.catalog().length, 0);
  assert.notEqual(first, f.consumer.catalog());
  const next = f.registry.access({ pluginId: 'provider', generation: 2, signal: signal() }, f.services, f.providerResources.track);
  next.register(definition);
  void release();
  assert.equal(f.consumer.catalog()[0]?.provider.generation, 2);
});

test('登记、成功变更及撤销通知可独立退订，历史错误不封锁新调用', async () => {
  const f = fixture();
  let calls = 0;
  const unsubscribe = f.consumer.subscribe(() => { calls++; });
  f.provider.register(definition);
  await assert.rejects(f.consumer.write(definition, { value: { name: '错误修订' }, expectedRevision: 'bad' }, signal()));
  await f.consumer.write(definition, { value: { name: '成功' }, expectedRevision: 'r1' }, signal());
  assert.equal(calls, 2);
  void unsubscribe();
  f.controller.abort();
  assert.equal(calls, 2);
});

test('提供者撤销收敛忽略取消的服务，不接受旧结果或自动启动新调用', async () => {
  const f = fixture();
  f.provider.register(definition);
  const pending = deferred<HostResult<JsonValue>>();
  let count = 0;
  const consumer = f.registry.access({ pluginId: 'observer', generation: 1, signal: signal() }, { call: () => { count++; return pending.promise; } }, f.consumerResources.track);
  const waiting = consumer.read(definition, signal());
  await Promise.resolve();
  f.controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
  pending.resolve({ data: { value: { name: '旧值' }, revision: 'old' }, logId: 'late-log' });
  await Promise.resolve();
  assert.equal(count, 1);
});

test('单独撤销数据源也取消所属等待，不要求卸载整个插件', async () => {
  const f = fixture();
  const release = f.provider.register(definition);
  const pending = deferred<HostResult<JsonValue>>();
  const consumer = f.registry.access({ pluginId: 'observer', generation: 1, signal: signal() }, { call: () => pending.promise }, f.consumerResources.track);
  const waiting = consumer.read(definition, signal());
  await Promise.resolve();
  void release();
  await assert.rejects(waiting, /另行查询/);
  assert.equal(f.controller.signal.aborted, false);
  f.provider.register(definition);
  pending.resolve({ data: { value: { name: '旧值' }, revision: 'old' }, logId: 'old-log' });
  assert.equal((await f.consumer.read(definition, signal())).data.revision, 'r1');
});

test('子作用域撤销登记和订阅，等待中的写入不因取消被重放', async () => {
  const f = fixture();
  const controller = new AbortController();
  const cleanup = resources();
  controller.signal.addEventListener('abort', () => cleanup.dispose(), { once: true });
  const scoped = scopedDataAccess(f.provider, controller.signal, cleanup.track);
  assert.ok(scoped);
  scoped.register(definition);
  let changes = 0;
  scoped.subscribe(() => { changes++; });
  controller.abort();
  assert.equal(f.consumer.catalog().length, 0);
  assert.throws(() => scoped.catalog(), /撤销/);
  await assert.rejects(scoped.read(definition, signal()), /撤销/);
  await assert.rejects(scoped.write(definition, { value: { name: '草稿' }, expectedRevision: 'r1' }, signal()), /撤销/);
  assert.equal(changes, 0);
  const pending = deferred<HostResult<never>>();
  let count = 0;
  const raw: DataAccess = { ...f.provider, write: () => { count++; return pending.promise; } };
  const scope = new AbortController();
  const access = scopedDataAccess(raw, scope.signal, cleanup.track);
  assert.ok(access);
  const result = access.write(definition, { value: { name: '草稿' }, expectedRevision: 'r1' }, signal());
  await Promise.resolve(); scope.abort();
  await assert.rejects(result, /另行查询/);
  assert.equal(count, 1);
});

test('运行环境关闭后目录与新调用均不可复活', async () => {
  const f = fixture();
  f.provider.register(definition);
  f.registry.dispose();
  f.registry.dispose();
  assert.throws(() => f.provider.catalog(), /撤销/);
  await assert.rejects(f.consumer.read(definition, signal()), /撤销/);
});
