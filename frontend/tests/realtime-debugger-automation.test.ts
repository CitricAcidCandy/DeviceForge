import assert from 'node:assert/strict';
import test from 'node:test';
import { runDebuggerAutomation } from '../src/app/debugger-automation/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { JsonValue } from '../src/plugin-sdk/index.ts';

const target = { plugin_id: 'demo', generation: '7' };
const node = { id: 'current-node', generation: 1, revision: 1 };
function fields(value: JsonValue | undefined): { readonly [key: string]: JsonValue } {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}
function steps(value: JsonValue) {
  const results = fields(value).steps;
  assert.ok(Array.isArray(results));
  return results.map(fields);
}
function action(id: string, expect?: JsonValue): JsonValue {
  return { id, tool: 'ui_action', parameters: { action: { type: 'click', target: node, confirmed: true },
    ...(expect === undefined ? {} : { expect }) } };
}
const exists: JsonValue = { kind: 'ui', assertion: { condition: 'exists', query: { name: '完成' } } };
const passed: JsonValue = { status: 'passed', scope: 'ui', reason: '本步骤检查点通过' };

test('末尾任意成功断言不能替前面未验证动作作证', async () => {
  const result = await runDebuggerAutomation({ confirmed: true, steps: [action('一'), action('二'),
    { id: '检查', tool: 'ui_assert', parameters: { assertion: { condition: 'exists', query: {} } } }] }, target,
  new AbortController().signal, async (tool) => tool === 'ui_assert'
    ? { status: 'passed', matched: 1, reason: '无关节点存在' }
    : { status: 'dispatched', businessOutcome: 'unknown' });
  assert.equal(fields(result).verified, false);
  assert.equal(fields(result).assertions_passed, 1);
  assert.equal(fields(result).business_outcome, 'unknown');
  assert.equal(steps(result)[0]?.verification, undefined);
});

test('四步一次提交，逐步保留控件、界面与业务验证并始终保持业务未知', async () => {
  const statuses = ['control', 'control', 'ui', 'business'];
  let calls = 0;
  const result = await runDebuggerAutomation({ confirmed: true,
    steps: [action('输入'), action('选择'), action('打开', exists), action('启动', {
      kind: 'data', source_id: 'state', checks: [{ pointer: '/running', equals: true }],
    })] }, target, new AbortController().signal, async () => ({
    status: 'dispatched', businessOutcome: 'unknown', verification: { status: 'passed', scope: statuses[calls++] ?? 'ui', reason: '本步骤验证通过' },
  }));
  assert.equal(calls, 4);
  assert.equal(fields(result).status, 'completed'); assert.equal(fields(result).verified, true);
  assert.deepEqual(steps(result).map((step) => fields(step.verification).scope), statuses);
  assert.deepEqual(steps(result).map((step) => step.business_outcome), ['unknown', 'unknown', 'unknown', 'unknown']);
  assert.equal(fields(result).business_outcome, 'unknown'); assert.equal(fields(result).replayed, false);
});

test('后续动作没有自己的检查点时整体仍未验证', async () => {
  let calls = 0;
  const result = await runDebuggerAutomation({ confirmed: true, steps: [action('已检查', exists), action('未检查')] }, target,
    new AbortController().signal, async () => ({ status: 'dispatched', businessOutcome: 'unknown',
      ...(calls++ === 0 ? { verification: passed } : {}) }));
  assert.equal(fields(result).verified, false);
  assert.equal(fields(steps(result)[0]?.verification).status, 'passed');
  assert.equal(steps(result)[1]?.verification, undefined);
});

test('只读查询或只读等待通过不能报告业务验证成功', async () => {
  for (const plan of [
    [{ id: '断言', tool: 'ui_assert', parameters: { assertion: { condition: 'exists', query: {} } } }],
    [{ id: '等待', tool: 'ui_action', parameters: { action: { type: 'wait', assertion: { condition: 'exists', query: {} } }, expect: exists } }],
  ]) {
    const result = await runDebuggerAutomation({ confirmed: true, steps: plan }, target,
      new AbortController().signal, async () => ({ status: 'passed', matched: 1, verification: passed }));
    assert.equal(fields(result).verified, false); assert.equal(fields(result).business_outcome, 'unknown');
  }
});

test('只读断言可以未确认，wait动作仍遵循原计划确认要求且拒绝前不派发', async () => {
  const assertion = { condition: 'exists', query: {} };
  const read = await runDebuggerAutomation({ confirmed: false,
    steps: [{ id: '只读断言', tool: 'ui_assert', parameters: { assertion } }] }, target,
  new AbortController().signal, async () => ({ status: 'passed', matched: 1 }));
  assert.equal(fields(read).status, 'completed');
  assert.equal(fields(read).verified, false);
  let calls = 0;
  await assert.rejects(runDebuggerAutomation({ confirmed: false,
    steps: [{ id: '等待', tool: 'ui_action', parameters: { action: { type: 'wait', assertion } } }] }, target,
  new AbortController().signal, async () => { calls++; return {}; }),
  (error: unknown) => error instanceof HostError && error.code === 'debugger_confirmation_required');
  assert.equal(calls, 0);
});

test('验证失败、不可读取或超时均不重放动作，未知时即使允许继续也停止', async () => {
  for (const status of ['failed', 'unavailable', 'timed_out']) {
    let calls = 0;
    const result = await runDebuggerAutomation({ confirmed: true, stop_on_failure: status === 'failed',
      steps: [action('动作', exists), action('后续')] }, target, new AbortController().signal, async () => {
      calls++;
      return { status: 'dispatched', businessOutcome: 'unknown', verification: { status, scope: 'ui', reason: '检查未通过' } };
    });
    assert.equal(calls, 1);
    assert.equal(steps(result)[0]?.status, status === 'failed' ? 'failed' : 'indeterminate');
    assert.equal(steps(result)[1]?.status, 'skipped');
    assert.equal(fields(result).verified, false); assert.equal(fields(result).replayed, false);
  }
});

test('结果裁剪仍保留本步骤验证证据，不借其他步骤补结论', async () => {
  const result = await runDebuggerAutomation({ confirmed: true, steps: [action('动作', exists)] }, target,
    new AbortController().signal, async () => ({ status: 'dispatched', businessOutcome: 'unknown',
      verification: passed, detail: '大结果'.repeat(10000) }));
  const step = steps(result)[0];
  assert.equal(step?.result, null);
  assert.equal(fields(step?.result_metadata).included, false);
  assert.deepEqual(step?.verification, passed);
});

test('后半段expect非法或固定节点和绑定并存时整计划无派发', async () => {
  const invalid: JsonValue[] = [
    action('空检查', { kind: 'data', source_id: 'state', checks: [] }),
    action('超预算', { kind: 'ui', assertion: { condition: 'exists', query: {} }, timeout_ms: 10001 }),
    action('错误值断言', { kind: 'ui', assertion: { condition: 'value_equals', query: {}, expected: 1 } }),
    action('错误选择断言', { kind: 'ui', assertion: { condition: 'selected_equals', query: {}, expected: ['重复', '重复'] } }),
    { id: '固定和绑定', tool: 'ui_action', parameters: { action: { type: 'click', target: node, confirmed: true } }, bind: { target_from_step: '查询' } },
  ];
  for (const step of invalid) {
    let calls = 0;
    await assert.rejects(runDebuggerAutomation({ confirmed: true, steps: [action('前置'),
      { id: '查询', tool: 'ui_query', parameters: { query: { role: 'button' } } }, step] }, target,
    new AbortController().signal, async () => { calls++; return {}; }));
    assert.equal(calls, 0);
  }
});
