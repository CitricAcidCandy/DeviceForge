import assert from 'node:assert/strict';
import test from 'node:test';
import { runDebuggerAutomation } from '../src/app/debugger-automation/index.ts';
import type { JsonValue } from '../src/plugin-sdk/index.ts';

const target = { plugin_id: 'example', generation: '7' };
function fields(value: JsonValue | undefined): { [key: string]: JsonValue } {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}
function steps(value: JsonValue) {
  const list = fields(value).steps;
  assert.ok(Array.isArray(list));
  return list.map(fields);
}

test('Agent可命名步骤，名称原样返回但不会将动作派发变成检查通过', async () => {
  const result = await runDebuggerAutomation({ confirmed: true, steps: [{
    id: 'stable-click', label: '检查通过', tool: 'ui_action', parameters: { action: {
      type: 'click', target: { id: 'node-a', generation: 1, revision: 1 }, confirmed: true,
    } },
  }] }, target, new AbortController().signal, async () => ({ status: 'dispatched' }));
  assert.equal(steps(result)[0]?.label, '检查通过');
  assert.equal(steps(result)[0]?.id, 'stable-click');
  assert.equal(fields(result).verified, false);
  assert.equal(steps(result)[0]?.business_outcome, 'unknown');
});

test('步骤名称缺省继续兼容，允许80个Unicode字符并拒绝超限和控制字符', async () => {
  const label = '🔍'.repeat(80);
  const result = await runDebuggerAutomation({ confirmed: false, steps: [
    { id: 'old', tool: 'inspect', parameters: {} },
    { id: 'unicode', label, tool: 'inspect', parameters: {} },
  ] }, target, new AbortController().signal, async () => ({}));
  assert.equal(Object.hasOwn(steps(result)[0] ?? {}, 'label'), false);
  assert.equal(steps(result)[1]?.label, label);
  for (const invalid of ['', '   ', '🔍'.repeat(81), '修改\n配置', '修改\u007f配置', 42, null]) {
    let calls = 0;
    await assert.rejects(runDebuggerAutomation({ confirmed: false, steps: [
      { id: 'before', tool: 'inspect', parameters: {} },
      { id: 'invalid', label: invalid, tool: 'inspect', parameters: {} },
    ] }, target, new AbortController().signal, async () => { calls++; return {}; }));
    assert.equal(calls, 0, '非法展示名称也应在所有步骤执行前拒绝');
  }
});

test('名称不参与修订绑定，重复名称合法且未执行步骤保留Agent名称', async () => {
  let written: JsonValue = null;
  const result = await runDebuggerAutomation({ confirmed: true, steps: [
    { id: 'read-id', label: '业务设置', tool: 'data_read', parameters: { source_id: 'settings' } },
    { id: 'write-id', label: '业务设置', tool: 'data_write', bind: { revision_from_step: 'read-id' },
      parameters: { source_id: 'settings', value: { count: 2 }, confirmed: true } },
    { id: 'after-id', label: '读取最新配置', tool: 'inspect', parameters: {} },
  ] }, target, new AbortController().signal, async (tool, _target, parameters) => {
    if (tool === 'data_read') return { source_id: 'settings', revision: 'opaque-r1', value: { count: 1 } };
    written = parameters;
    throw new Error('模拟保存结果未确认');
  });
  assert.equal(fields(written).expected_revision, 'opaque-r1');
  assert.equal(steps(result)[2]?.status, 'skipped');
  assert.equal(steps(result)[2]?.label, '读取最新配置');
});
