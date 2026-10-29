import assert from 'node:assert/strict';
import test from 'node:test';
import { createDebuggerController } from '../../examples/browser-debugger/src/controller.ts';
import type { DebuggerState, EventRow } from '../../examples/browser-debugger/src/controller.ts';
import type { ActivityItem, Target } from '../../examples/browser-debugger/src/protocol.ts';
import { object } from '../../examples/browser-debugger/src/protocol.ts';
import { localReport, markdownReport } from '../../examples/browser-debugger/src/report.ts';

const target: Target = { kind: 'browser', instanceId: 'window-1', pluginId: 'example', generation: '7', version: '1' };
const item: ActivityItem = { sequence: 12, commandId: 'agent-command', tool: 'automation_run', state: 'timed_out_unconfirmed',
  steps: [{ id: 'read', label: '读取当前配置', tool: 'data_read' }],
  response: { status: 'indeterminate', steps: [{ id: 'read', label: '读取当前配置', status: 'succeeded', result: { value: { prefix: '工作' } } }] } };
function state(): { readonly value: DebuggerState; readonly dispose: () => Promise<void> | undefined } {
  const controller = createDebuggerController({ signal: new AbortController().signal });
  return { value: { ...controller.snapshot(), target, stale: true, activity: { target, items: [{ ...item, response: null }],
    nextBefore: 10, gap: true, retainedOnly: true }, activityDetail: item }, dispose: controller.dispose };
}
const event = (key: string, owner: Target): EventRow => ({ key, sequence: 1, target: owner, sessionId: 'observer',
  level: 'info', label: key, logId: null, raw: { name: key } });

test('本地JSON报告包含已缓存活动及原回执并保持只读缺口范围，不需要公开服务', async () => {
  const fixture = state();
  try {
    const exported = object(localReport(fixture.value, 0)), scope = object(exported.activity_scope);
    assert.equal(object(exported.activity_detail).commandId, 'agent-command');
    assert.equal(object(exported.activity_detail).state, 'timed_out_unconfirmed');
    assert.deepEqual(object(exported.activity_detail).response, item.response);
    assert.equal(scope.read_only, true); assert.equal(scope.cached_only, true);
    assert.equal(scope.retained_only, true); assert.equal(scope.gap, true); assert.equal(scope.next_before, 10);
    assert.equal(exported.stale, true);
  } finally { await fixture.dispose(); }
});

test('Markdown包含展示名称和真实原状态，明确历史缺口且不把名称当通过', async () => {
  const fixture = state();
  try {
    const markdown = markdownReport(fixture.value, 0);
    assert.match(markdown, /调试调用摘要/); assert.match(markdown, /读取当前配置/);
    assert.match(markdown, /timed_out_unconfirmed/); assert.match(markdown, /存在淘汰缺口/);
    assert.match(markdown, /没有追加查询或重新执行/); assert.doesNotMatch(markdown, /完整业务检查通过/);
  } finally { await fixture.dispose(); }
});

test('报告拒绝导出其他窗口或代次活动和同插件外目标事件，未关联详情不混入', async () => {
  const fixture = state();
  try {
    const foreign: Target = { ...target, instanceId: 'window-2' };
    const activity = fixture.value.activity; assert.ok(activity);
    const foreignState: DebuggerState = { ...fixture.value, activity: { ...activity, target: foreign },
      events: [event('当前', target), event('外窗口', foreign), event('旧代', { ...target, generation: '6' })] };
    const exported = object(localReport(foreignState, 0));
    assert.equal(exported.activity, null); assert.equal(exported.activity_detail, null);
    assert.deepEqual(exported.events, [event('当前', target)]);
    const unlinked: DebuggerState = { ...fixture.value, activityDetail: { ...item, commandId: 'other-command' } };
    assert.equal(object(localReport(unlinked, 0)).activity_detail, null);
  } finally { await fixture.dispose(); }
});
