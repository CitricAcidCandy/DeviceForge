import assert from 'node:assert/strict';
import test from 'node:test';
import { activitySteps, activitySummary, presentStep } from '../../examples/browser-debugger/src/activity-presentation.ts';

test('Agent步骤名称只影响展示，不能覆盖失败、未知或页面断言状态', () => {
  const failed = presentStep({ id: 'one', label: '检查通过', tool: 'ui_assert', status: 'failed', result: { status: 'failed' } });
  assert.equal(failed.label, '检查通过'); assert.equal(failed.status, '执行失败'); assert.equal(failed.tone, 'error');
  const unknown = presentStep({ id: 'two', label: '<b>已经成功</b>', tool: 'data_write', status: 'indeterminate', result: null });
  assert.equal(unknown.label, '<b>已经成功</b>'); assert.equal(unknown.status, '结果未确认');
  const action = presentStep({ id: 'three', tool: 'ui_action', status: 'succeeded', result: { status: 'dispatched' } });
  assert.equal(action.label, '操作界面'); assert.equal(action.status, '已派发，业务结果未确认');
});

test('整计划未返回前预定步骤统一等待最终回执，不推导实时进度', () => {
  const value = { commandId: 'command', tool: 'automation_run', state: 'delivered', steps: [
    { id: 'read', tool: 'data_read', label: '读取配置' }, { id: 'check', tool: 'ui_assert', label: '检查名称' },
  ], response: null };
  assert.deepEqual(activitySteps(value).map(step => step.status), ['等待最终回执', '等待最终回执']);
  assert.equal(activitySummary(value, false).title, '计划执行中');
  assert.doesNotMatch(JSON.stringify(activitySteps(value)), /页面检查通过|已读取/);
});

test('只有真实passed断言显示通过，派发和保存不会扩大业务成功', () => {
  const value = { commandId: 'command', tool: 'automation_run', state: 'succeeded', steps: [], response: {
    status: 'completed', steps: [
      { id: 'save', tool: 'data_write', status: 'succeeded', result: { revision: 'new', value: { prefix: '工作-' } } },
      { id: 'assert', tool: 'ui_assert', status: 'succeeded', result: { status: 'passed' } },
      { id: 'later', tool: 'ui_assert', status: 'skipped', result: null },
    ],
  } };
  assert.deepEqual(activitySteps(value).map(step => step.status), ['已保存并回读', '页面检查通过', '未执行']);
  assert.equal(activitySummary(value, false).title, '调试结束 · 1项页面检查通过');
  assert.match(activitySummary(value, true).description, /当前页面状态尚未确认/);
});

test('缺失或失败断言结果保持无法判定或失败，不把命令成功视为检查通过', () => {
  assert.equal(presentStep({ tool: 'ui_assert', status: 'succeeded', result: {} }).status, '无法判定');
  assert.equal(presentStep({ tool: 'ui_assert', status: 'succeeded', result: { status: 'failed' } }).status, '页面检查未通过');
  assert.equal(activitySummary({ commandId: 'one', state: 'succeeded', tool: 'ui_action', response: {} }, false).title, '调试调用已结束');
});
