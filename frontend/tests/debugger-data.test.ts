import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugDataSourceDefinition, DebugDataSnapshot, Dispose, JsonValue } from '../src/plugin-sdk/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import { createDebugRegistry, scopedDebugAccess } from '../src/plugins/debugger/index.ts';
import { copyDataJson } from '../src/plugins/debugger/data-json.ts';

function fixture() {
  const controller = new AbortController();
  const releases: Dispose[] = [];
  const track = (dispose: Dispose) => { releases.push(dispose); return dispose; };
  const registry = createDebugRegistry({ pluginId: 'example', generation: 1 }, controller.signal, track);
  return { controller, registry, track, async close() { controller.abort(); await registry.dispose(); } };
}
function source(extra: Partial<DebugDataSourceDefinition> = {}): DebugDataSourceDefinition {
  return { id: 'items', label: '业务数据', schema: { type: 'object', required: ['value'], additionalProperties: false,
    properties: { value: { type: 'integer', minimum: 0 } } }, persistence: 'memory', applyPolicy: 'immediate',
    read: async () => ({ revision: 'r1', value: { value: 1 } }), ...extra };
}
function code(expected: string) {
  return (error: unknown) => error instanceof HostError && error.code === `debugger_${expected}`;
}
function deferred<T>() {
  let finish: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => { finish = resolve; });
  return { promise, resolve(value: T) { assert.ok(finish); finish(value); } };
}

test('数据目录不读业务数据，旧释放函数不撤销同名新源', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const register = f.registry.debug.registerDataSource; assert.ok(register);
    const first = register(source({ read: async () => { reads++; return { revision: 'r1', value: { value: 1 } }; } }));
    assert.equal(f.registry.data.catalog()[0]?.writable, false);
    assert.equal(reads, 0);
    await first();
    const release = register(source());
    await first();
    assert.equal(f.registry.data.catalog().length, 1);
    assert.deepEqual((await f.registry.data.read('items', null, f.controller.signal)).value, { value: 1 });
    await release();
    assert.deepEqual(f.registry.data.catalog(), []);
  } finally { await f.close(); }
});

test('同名新登记复用插件修订时拒绝旧公开修订，有限历史过期后要求重读', async () => {
  const f = fixture();
  try {
    let rawRevision = 'r1', writes = 0;
    const definition = source({ read: async () => ({ revision: rawRevision, value: { value: 1 } }), write: async () => { writes++; } });
    const revoke = f.registry.data.register(definition);
    const previous = (await f.registry.data.read('items', null, f.controller.signal)).revision;
    await revoke(); f.registry.data.register(definition);
    const current = (await f.registry.data.read('items', null, f.controller.signal)).revision;
    assert.notEqual(current, previous);
    await assert.rejects(f.registry.data.write('items', { expectedRevision: previous, value: { value: 2 } }, f.controller.signal), code('revision_conflict'));
    for (let index = 2; index <= 34; index++) {
      rawRevision = `r${index}`;
      await f.registry.data.read('items', null, f.controller.signal);
    }
    rawRevision = 'r1';
    await assert.rejects(f.registry.data.write('items', { expectedRevision: current, value: { value: 2 } }, f.controller.signal), code('revision_conflict'));
    assert.equal(writes, 0);
  } finally { await f.close(); }
});

test('数据写入按修订校验并回读真实归一化值，不复制调用输入', async () => {
  const f = fixture();
  try {
    let state: DebugDataSnapshot = { revision: 'r1', value: { value: 1 } };
    let writes = 0;
    f.registry.data.register(source({ read: async () => state,
      write: async request => {
        assert.equal(request.expectedRevision, state.revision);
        writes++; state = { revision: 'r2', value: { value: 3 } };
      } }));
    const input = { value: 2 };
    const expectedRevision = (await f.registry.data.read('items', null, f.controller.signal)).revision;
    const result = await f.registry.data.write('items', { expectedRevision, value: input }, f.controller.signal);
    assert.deepEqual(result.value, { value: 3 }); assert.notEqual(result.revision, expectedRevision);
    assert.deepEqual(input, { value: 2 }); assert.equal(writes, 1);
    await assert.rejects(f.registry.data.write('items', { expectedRevision, value: input }, f.controller.signal), code('revision_conflict'));
    assert.equal(writes, 1);
  } finally { await f.close(); }
});

test('无效模式、只读源、字段只读及越界写入在插件调用前拒绝', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.registry.data.register(source({ schema: { type: 'nonsense' } })), code('invalid_schema'));
    assert.throws(() => f.registry.data.register(source({ schema: [] })), code('invalid_schema'));
    f.registry.data.register(source());
    await assert.rejects(f.registry.data.write('items', { expectedRevision: 'r1', value: { value: 2 } }, f.controller.signal), code('data_read_only'));
    let calls = 0;
    f.registry.data.register(source({ id: 'locked', schema: { type: 'object', properties: { value: { type: 'integer', readOnly: true } } },
      write: async () => { calls++; } }));
    const expectedRevision = (await f.registry.data.read('locked', null, f.controller.signal)).revision;
    await assert.rejects(f.registry.data.write('locked', { expectedRevision, value: { value: 2 } }, f.controller.signal), code('data_read_only'));
    await assert.rejects(f.registry.data.write('locked', { expectedRevision, value: { value: 'invalid' } }, f.controller.signal), code('invalid_data'));
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('凭据与模式敏感值脱敏但保留普通 value，敏感源拒绝完整替换', async () => {
  const f = fixture();
  try {
    let writes = 0;
    f.registry.data.register(source({ schema: { type: 'object', properties: {
      value: { type: 'string' }, token: { type: 'string', default: 'private-default', enum: ['private-choice'] },
      hidden: { type: 'string', writeOnly: true, examples: ['private-example'] } } },
      read: async () => ({ revision: 'r1', value: { value: '业务', token: 'private-choice', hidden: 'private-hidden' } }),
      write: async () => { writes++; } }));
    const result = await f.registry.data.read('items', null, f.controller.signal);
    assert.deepEqual(result.value, { value: '业务', token: '[已脱敏]', hidden: '[已脱敏]' });
    assert.equal(f.registry.data.catalog()[0]?.writable, false);
    const catalog = JSON.stringify(f.registry.data.catalog());
    assert.ok(!catalog.includes('private-'));
    await assert.rejects(f.registry.data.write('items', { expectedRevision: 'r1', value: { value: '业务' } }, f.controller.signal), code('sensitive_data_write'));
    assert.equal(writes, 0);
  } finally { await f.close(); }
});

test('普通token计数作为业务数据保留，凭据后缀仍脱敏', async () => {
  const f = fixture();
  try {
    f.registry.data.register(source({ schema: true, read: async () => ({ revision: 'r1', value: {
      token_count: 100, tokenCount: 101, value: '业务读数', access_token: 'private-token', servicePassword: 'private-password',
    } }) }));
    assert.deepEqual((await f.registry.data.read('items', null, f.controller.signal)).value, {
      token_count: 100, tokenCount: 101, value: '业务读数', access_token: '[已脱敏]', servicePassword: '[已脱敏]',
    });
  } finally { await f.close(); }
});

test('宽松模式也拒绝现有或新写入凭据，不执行写回', async () => {
  const f = fixture();
  try {
    let writes = 0;
    f.registry.data.register(source({ schema: true, write: async () => { writes++; } }));
    const firstRevision = (await f.registry.data.read('items', null, f.controller.signal)).revision;
    await assert.rejects(f.registry.data.write('items', { expectedRevision: firstRevision, value: { accessToken: 'private' } }, f.controller.signal), code('sensitive_data_write'));
    f.registry.data.register(source({ id: 'existing', schema: true, read: async () => ({ revision: 'r1', value: { password: 'private' } }),
      write: async () => { writes++; } }));
    const otherRevision = (await f.registry.data.read('existing', null, f.controller.signal)).revision;
    await assert.rejects(f.registry.data.write('existing', { expectedRevision: otherRevision, value: {} }, f.controller.signal), code('sensitive_data_write'));
    assert.equal(writes, 0);
  } finally { await f.close(); }
});

test('模式注解沿本地引用、组合分支和数组传播，读取脱敏与只读写入保持一致', async () => {
  const f = fixture();
  try {
    f.registry.data.register(source({ id: 'private', schema: { type: 'object', definitions: {
      hidden: { type: 'string', writeOnly: true },
    }, properties: { values: { type: 'array', items: { allOf: [{ $ref: '#/definitions/hidden' }, { type: 'string' }] } } } },
    read: async () => ({ revision: 'r1', value: { values: ['private-item', 'private-item-two'] } }) }));
    const masked = await f.registry.data.read('private', null, f.controller.signal);
    assert.deepEqual(masked.value, { values: ['[已脱敏]', '[已脱敏]'] });
    let writes = 0;
    f.registry.data.register(source({ id: 'readonly', schema: { type: 'object', definitions: {
      locked: { type: 'integer', readOnly: true },
    }, allOf: [{ properties: { value: { $ref: '#/definitions/locked' } } }] }, write: async () => { writes++; } }));
    const expectedRevision = (await f.registry.data.read('readonly', null, f.controller.signal)).revision;
    await assert.rejects(f.registry.data.write('readonly', { expectedRevision, value: { value: 2 } }, f.controller.signal), code('data_read_only'));
    assert.equal(writes, 0);
  } finally { await f.close(); }
});

test('插件回读失败保留写入未确认，不重放且后续读取可用', async () => {
  const f = fixture();
  try {
    let writes = 0, failRead = false;
    f.registry.data.register(source({ read: async () => {
      if (failRead) throw new Error('private-plugin-error');
      return { revision: String(writes), value: { value: writes } };
    }, write: async () => { writes++; failRead = true; } }));
    const expectedRevision = (await f.registry.data.read('items', null, f.controller.signal)).revision;
    await assert.rejects(f.registry.data.write('items', { expectedRevision, value: { value: 2 } }, f.controller.signal), code('result_unconfirmed'));
    assert.equal(writes, 1);
    failRead = false;
    assert.deepEqual((await f.registry.data.read('items', null, f.controller.signal)).value, { value: 1 });
  } finally { await f.close(); }
});

test('插件内原子修订冲突单独返回，宿主预读不替代真实CAS', async () => {
  const f = fixture();
  try {
    let writes = 0;
    f.registry.data.register(source({ write: async () => {
      writes++;
      throw new HostError('protocol', 'debugger_revision_conflict', 'private-conflict-details');
    } }));
    const expectedRevision = (await f.registry.data.read('items', null, f.controller.signal)).revision;
    await assert.rejects(f.registry.data.write('items', { expectedRevision, value: { value: 2 } }, f.controller.signal), code('revision_conflict'));
    assert.equal(writes, 1);
  } finally { await f.close(); }
});

test('读取旧源期间撤销后不继续写入，新同名源独立可用', async () => {
  const f = fixture();
  try {
    const delayed = deferred<DebugDataSnapshot>();
    const entered = deferred<void>();
    let writes = 0, block = false;
    const revoke = f.registry.data.register(source({ read: async () => {
      if (!block) return { revision: 'r1', value: { value: 1 } };
      entered.resolve(); return delayed.promise;
    }, write: async () => { writes++; } }));
    const expectedRevision = (await f.registry.data.read('items', null, f.controller.signal)).revision;
    block = true;
    const pending = f.registry.data.write('items', { expectedRevision, value: { value: 2 } }, f.controller.signal);
    const rejected = assert.rejects(pending, code('data_cancelled'));
    await entered.promise; await revoke();
    f.registry.data.register(source());
    delayed.resolve({ revision: 'r1', value: { value: 1 } });
    await rejected;
    assert.equal(writes, 0);
    assert.deepEqual((await f.registry.data.read('items', null, f.controller.signal)).value, { value: 1 });
  } finally { await f.close(); }
});

test('写入取消标记结果未确认并释放等待额度，不宣称实际回调已终止', async () => {
  const f = fixture();
  try {
    const delayed = deferred<void>(), entered = deferred<void>();
    const caller = new AbortController();
    let writes = 0;
    f.registry.data.register(source({ write: async () => { writes++; entered.resolve(); return delayed.promise; } }));
    const expectedRevision = (await f.registry.data.read('items', null, f.controller.signal)).revision;
    const pending = f.registry.data.write('items', { expectedRevision, value: { value: 2 } }, caller.signal);
    const rejected = assert.rejects(pending, code('result_unconfirmed'));
    await entered.promise;
    await assert.rejects(f.registry.data.write('items', { expectedRevision, value: { value: 3 } }, f.controller.signal), code('data_source_busy'));
    caller.abort(); await rejected;
    assert.equal((await f.registry.data.read('items', null, f.controller.signal)).revision, expectedRevision);
    delayed.resolve(); assert.equal(writes, 1);
  } finally { await f.close(); }
});

test('十秒共享预算含预读与写入，超时不阻塞后续独立调用', async context => {
  const f = fixture();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const entered = deferred<void>(), delayed = deferred<void>();
    f.registry.data.register(source({ write: async () => { entered.resolve(); return delayed.promise; } }));
    const expectedRevision = (await f.registry.data.read('items', null, f.controller.signal)).revision;
    const pending = f.registry.data.write('items', { expectedRevision, value: { value: 2 } }, f.controller.signal);
    const rejected = assert.rejects(pending, code('result_unconfirmed'));
    await entered.promise;
    context.mock.timers.tick(10000); await rejected;
    assert.equal((await f.registry.data.read('items', null, f.controller.signal)).revision, expectedRevision);
    delayed.resolve();
  } finally { context.mock.timers.reset(); await f.close(); }
});

test('数据源结构拒绝访问器非JSON深层与超量数据，异常消息不泄漏插件原文', async () => {
  let getterCalls = 0;
  assert.throws(() => copyDataJson({ get item() { getterCalls++; return 1; } }), code('invalid_data'));
  assert.equal(getterCalls, 0);
  assert.throws(() => copyDataJson('x'.repeat(256 * 1024 + 1)), code('limit_exceeded'));
  let deep: JsonValue = null;
  for (let index = 0; index < 18; index++) deep = { child: deep };
  assert.throws(() => copyDataJson(deep), code('limit_exceeded'));
  const f = fixture();
  try {
    f.registry.data.register(source({ read: async () => { throw new Error('private-error-sentinel'); } }));
    await assert.rejects(f.registry.data.read('items', null, f.controller.signal), error => code('data_read_failed')(error) && !String(error).includes('private-error-sentinel'));
  } finally { await f.close(); }
});

test('业务值256KiB边界独立于回执包络，超过边界明确拒绝', async () => {
  const f = fixture();
  try {
    let value = 'x'.repeat(256 * 1024 - 2);
    f.registry.data.register(source({ schema: true, read: async () => ({ revision: 'r1', value }) }));
    const result = await f.registry.data.read('items', null, f.controller.signal);
    assert.equal(result.value, value);
    value += 'x';
    await assert.rejects(f.registry.data.read('items', null, f.controller.signal), code('limit_exceeded'));
  } finally { await f.close(); }
});

test('数据源上限、重复标识与子作用域释放互不污染兄弟源', async () => {
  const f = fixture();
  const child = new AbortController(), sibling = new AbortController();
  const releases: Dispose[] = [];
  const track = (dispose: Dispose) => { releases.push(dispose); return dispose; };
  try {
    const access = scopedDebugAccess(f.registry.debug, child.signal, track);
    const other = scopedDebugAccess(f.registry.debug, sibling.signal, track);
    assert.ok(access.registerDataSource); assert.ok(other.registerDataSource);
    access.registerDataSource(source()); other.registerDataSource(source({ id: 'other' }));
    assert.throws(() => f.registry.data.register(source()), code('data_source_conflict'));
    child.abort();
    assert.deepEqual(f.registry.data.catalog().map(item => item.id), ['other']);
    for (let index = 1; index < 64; index++) f.registry.data.register(source({ id: `extra-${index}` }));
    assert.throws(() => f.registry.data.register(source({ id: 'overflow' })), code('data_source_conflict'));
    sibling.abort();
  } finally { for (const release of releases) await release(); await f.close(); }
});
