import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { verifyAction } from '../src/app/debugger-local/verification.ts';
import { expectation } from '../src/app/debugger-local/ui-parameters.ts';
import { createLocalUi, clearCollectors } from '../src/app/debugger-local/ui.ts';
import { createAttachment } from '../src/app/debugger-local/attachment.ts';
import { executeData } from '../src/app/debugger-local/data.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import type { DebugDataSnapshot, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

test('检查参数保留wire层级、默认3秒与上限，拒绝非法Pointer和检查数量', () => {
  const value = expectation({ kind: 'ui', assertion: { condition: 'value_equals', query: {}, expected: '' } });
  assert.equal(value.timeout_ms, 3000);
  assert.equal(expectation({ kind: 'data', source_id: 'state', checks: [{ pointer: '/field', equals: null }], timeout_ms: 10000 }).timeout_ms, 10000);
  for (const invalid of [
    { kind: 'ui', assertion: { condition: 'exists', query: {} }, timeout_ms: 10001 },
    { kind: 'ui', assertion: { condition: 'exists', query: {} }, timeout_ms: -1 },
    { kind: 'data', source_id: 'state', checks: [] },
    { kind: 'data', source_id: 'state', checks: [{ pointer: '', equals: null }] },
    { kind: 'data', source_id: 'state', checks: Array.from({ length: 17 }, () => ({ pointer: '/field', equals: null })) },
    { kind: 'data', source_id: 'state', checks: [{ pointer: 'not-pointer', equals: 1 }] },
    { kind: 'data', source_id: 'state', checks: [{ pointer: '/bad~2escape', equals: 1 }] },
    { kind: 'data', source_id: 'state', checks: [{ pointer: '/bad~', equals: 1 }] },
    { kind: 'data', source_id: 'state', checks: [{ pointer: '/state' }] },
    { kind: 'ui', assertion: { condition: 'selected_equals', query: {}, expected: ['a', 'a'] } },
  ]) assert.throws(() => expectation(invalid));
});

test('只读公开业务投影，JSON Pointer支持转义和数组且比较不受对象键序影响', async () => {
  let query: JsonValue | undefined;
  const result = await verifyAction(expectation({ kind: 'data', source_id: 'state', query: { scope: 'public' }, checks: [
    { pointer: '/a~1b/~0key/0', equals: { y: 2, x: 1 } },
    { pointer: '/ready', equals: true },
  ] }), {
    async readData(sourceId, input) {
      assert.equal(sourceId, 'state'); query = input;
      return { source_id: 'state', revision: 'r1', value: { 'a/b': { '~key': [{ x: 1, y: 2 }] }, ready: true } };
    },
  }, new AbortController().signal);
  assert.deepEqual(query, { scope: 'public' });
  assert.equal(result.status, 'passed'); assert.equal(result.scope, 'business');
  assert.equal(JSON.stringify(result).includes('~key'), false);
});

test('无端口、无登记源、字段缺失、跨来源和已脱敏字段均明确不可验证', async () => {
  const expected = expectation({ kind: 'data', source_id: 'state', checks: [{ pointer: '/ready', equals: true }] });
  const signal = new AbortController().signal;
  assert.equal((await verifyAction(expected, {}, signal)).status, 'unavailable');
  for (const raw of [
    { source_id: 'other', value: { ready: true } },
    { source_id: 'state', value: {} },
    { source_id: 'state', value: { ready: '[已脱敏]' } },
  ]) assert.equal((await verifyAction(expected, { readData: async () => raw }, signal)).status, 'unavailable');
  assert.equal((await verifyAction(expected, { readData: async () => { throw new Error('无登记数据源'); } }, signal)).status, 'unavailable');
  assert.equal((await verifyAction(expectation({ kind: 'data', source_id: 'state', checks: [{ pointer: '/api_key', equals: '猜测' }] }), {
    readData: async () => ({ source_id: 'state', value: { api_key: '猜测' } }),
  }, signal)).status, 'unavailable');
});

test('检查预算覆盖永不返回的数据读取，过期后忽略晚到通过结果', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let release: (value: JsonValue) => void = () => {};
  let reads = 0;
  const running = verifyAction(expectation({ kind: 'data', source_id: 'state', checks: [{ pointer: '/ready', equals: true }] }), {
    readData: () => { reads++; return new Promise<JsonValue>((resolve) => { release = resolve; }); },
  }, new AbortController().signal);
  await Promise.resolve();
  context.mock.timers.tick(3000);
  const result = await running;
  assert.equal(result.status, 'timed_out'); assert.equal(reads, 1);
  release({ source_id: 'state', value: { ready: true } });
  await Promise.resolve();
  assert.equal(result.status, 'timed_out'); assert.equal(reads, 1);
});

test('原signal先于检查预算结束时立即收敛，读取信号也被撤销', async () => {
  const caller = new AbortController();
  let observed: AbortSignal | undefined;
  const running = verifyAction(expectation({ kind: 'data', source_id: 'state', checks: [{ pointer: '/ready', equals: true }], timeout_ms: 10000 }), {
    readData: (_source, _query, signal) => { observed = signal; return new Promise<JsonValue>(() => {}); },
  }, caller.signal);
  await Promise.resolve(); caller.abort();
  assert.equal((await running).status, 'timed_out');
  assert.equal(observed?.aborted, true);
});

test('界面断言不完整时不扩大查询，反例只在本次预算内等待', async () => {
  const expected = expectation({ kind: 'ui', assertion: { condition: 'exists', query: { name: '完成' } }, timeout_ms: 0 });
  let checks = 0;
  const unavailable = await verifyAction(expected, { assert: () => { checks++; return { status: 'indeterminate', matched: 1, reason: '覆盖不足' }; } }, new AbortController().signal);
  assert.equal(unavailable.status, 'unavailable'); assert.equal(checks, 1);
  const timed = await verifyAction(expected, { assert: () => ({ status: 'failed', matched: 0, reason: '尚未完成' }) }, new AbortController().signal);
  assert.equal(timed.status, 'timed_out'); assert.equal(timed.scope, 'ui');
});

function uiFixture(injectData = true) {
  const dom = new JSDOM('<main data-deviceforge-plugin="demo" data-deviceforge-generation="7" data-deviceforge-panel="demo.panel"><button type="button" data-deviceforge-action="local">执行</button></main>');
  const lifetime = new AbortController();
  const host: HostContext = { apiVersion: 2, signal: lifetime.signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('不提交业务任务'); }, getJob: async () => { throw new Error('不读取业务任务'); },
    cancelJob: async () => { throw new Error('不取消业务任务'); }, subscribeOperations: () => () => {}, onDispose: () => () => {} };
  const extensions = createExtensionRegistry();
  const manager = createPluginManager({ host, extensionRegistry: extensions, panelTarget: () => null });
  const scope = createPluginScope(host);
  const entry = createAttachment('demo', '7', scope, lifetime.signal, () => true, () => {});
  const options = { document: dom.window.document, signal: lifetime.signal, manager: () => manager, extensions };
  const ui = createLocalUi(options, () => [entry], injectData
    ? (current, input, signal) => executeData('data_read', current, input, signal) : undefined);
  const target = { plugin_id: 'demo', generation: '7' };
  const run = (tool: string, input: Record<string, unknown>, signal = lifetime.signal) => ui.execute(tool, target, entry, input, signal);
  async function click(expect: unknown, signal = lifetime.signal) {
    const query = record(await run('ui_query', { query: { role: 'button', name: '执行' } }));
    assert.ok(Array.isArray(query.nodes));
    assert.equal(query.complete, true);
    assert.equal(query.nodes.length, 1);
    const node = record(query.nodes[0]);
    return record(await run('ui_action', { action: { type: 'click', confirmed: true,
      target: { id: node.id, generation: node.generation, revision: node.revision } }, expect }, signal));
  }
  const button = dom.window.document.querySelector('button'); assert.ok(button);
  return { dom, lifetime, entry, button, click,
    async close() { clearCollectors(entry); lifetime.abort(); await scope.dispose(); await manager.dispose(); extensions.dispose(); dom.window.close(); } };
}

test('本地动作通过注入的原data_read检查公开源，不改变动作状态或返回原值', async () => {
  const item = uiFixture();
  try {
    const register = item.entry.access.registerDataSource; assert.ok(register);
    let running = false, clicks = 0;
    item.button.addEventListener('click', () => { clicks++; running = true; });
    register({ id: 'public-state', label: '业务状态', schema: true, persistence: 'memory', applyPolicy: 'immediate',
      read: async () => ({ revision: 'r1', value: { running, detail: '不可写入回执的业务正文' } }) });
    const result = await item.click({ kind: 'data', source_id: 'public-state', checks: [{ pointer: '/running', equals: true }] });
    assert.equal(result.status, 'dispatched'); assert.equal(result.businessOutcome, 'unknown');
    assert.equal(record(result.verification).status, 'passed'); assert.equal(record(result.verification).scope, 'business');
    assert.equal(clicks, 1);
    assert.equal(JSON.stringify(result).includes('不可写入回执的业务正文'), false);
  } finally { await item.close(); }
});

test('ui_action检查默认3秒到期或原预算取消均只派发一次，忽略晚到回读', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const cancel of [false, true]) {
    const item = uiFixture();
    const caller = new AbortController();
    try {
      const register = item.entry.access.registerDataSource; assert.ok(register);
      let clicks = 0, reads = 0;
      let observed: AbortSignal | undefined;
      let notifyRead = () => {};
      let release: (value: DebugDataSnapshot) => void = () => {};
      const started = new Promise<void>((resolve) => { notifyRead = resolve; });
      item.button.addEventListener('click', () => { clicks++; });
      register({ id: 'slow-state', label: '延迟业务状态', schema: true, persistence: 'memory', applyPolicy: 'immediate',
        read: (_query, signal) => {
          reads++; observed = signal; notifyRead();
          return new Promise<DebugDataSnapshot>((resolve) => { release = resolve; });
        } });
      const pending = item.click({ kind: 'data', source_id: 'slow-state', checks: [{ pointer: '/running', equals: true }] }, caller.signal);
      await started;
      if (cancel) caller.abort();
      else context.mock.timers.tick(3000);
      const result = await pending;
      assert.equal(result.status, 'dispatched'); assert.equal(result.businessOutcome, 'unknown');
      assert.equal(record(result.verification).status, 'timed_out');
      assert.equal(record(result.verification).scope, 'business');
      assert.equal(observed?.aborted, true);
      assert.equal(clicks, 1); assert.equal(reads, 1);
      release({ revision: 'late', value: { running: true } });
      await Promise.resolve(); await Promise.resolve();
      assert.equal(record(result.verification).status, 'timed_out');
      assert.equal(clicks, 1); assert.equal(reads, 1);
    } finally { caller.abort(); await item.close(); }
  }
});

test('缺少公开状态或注入端口时动作只执行一次并明确结果未知', async () => {
  for (const injectData of [true, false]) {
    const item = uiFixture(injectData);
    try {
      let clicks = 0; item.button.addEventListener('click', () => { clicks++; });
      const result = await item.click({ kind: 'data', source_id: 'absent', checks: [{ pointer: '/running', equals: true }] });
      assert.equal(record(result.verification).status, 'unavailable');
      assert.equal(result.status, 'dispatched'); assert.equal(result.businessOutcome, 'unknown'); assert.equal(clicks, 1);
    } finally { await item.close(); }
  }
});

test('ui_action的expect必须在派发之前校验，正确界面检查只关联本动作', async () => {
  const item = uiFixture();
  try {
    let clicks = 0;
    item.button.addEventListener('click', () => {
      clicks++;
      const message = item.dom.window.document.createElement('span');
      message.setAttribute('role', 'status'); message.textContent = '本次完成';
      item.button.after(message);
    });
    await assert.rejects(item.click({ kind: 'data', source_id: 'state', checks: [] }));
    assert.equal(clicks, 0);
    const result = await item.click({ kind: 'ui', assertion: { condition: 'exists', query: { role: 'status', name: '本次完成' } } });
    assert.equal(record(result.verification).status, 'passed'); assert.equal(record(result.verification).scope, 'ui');
    assert.equal(result.businessOutcome, 'unknown'); assert.equal(clicks, 1);
  } finally { await item.close(); }
});
