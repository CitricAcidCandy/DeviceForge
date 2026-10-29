import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import { array, json, object, text } from './protocol.ts';

export interface PresentedStep {
  readonly id: string;
  readonly label: string;
  readonly tool: string;
  readonly status: string;
  readonly tone: 'neutral' | 'success' | 'warning' | 'error';
  readonly result: JsonValue;
  readonly detail: string;
  readonly logId: string | null;
}
const toolLabels: Readonly<Record<string, string>> = { inspect: '检查插件', data_catalog: '查看数据目录',
  data_read: '读取数据', data_write: '修改数据', ui_tree: '读取界面', ui_query: '查找界面元素',
  ui_assert: '检查页面结果', ui_action: '操作界面', invoke: '调用公开能力', reload: '重载插件', report: '汇总报告',
  automation_run: '自动调试计划' };
export const toolLabel = (tool: string): string => toolLabels[tool] ?? '调试调用';

// 展示名称与执行状态分别取值；Agent提供的名称不能把失败或未知结果改为通过。
export function presentStep(value: JsonValue, pending = false): PresentedStep {
  const step = object(value), result = object(step.result), error = object(step.error);
  const tool = text(step.tool), status = text(step.status);
  let state = '调用完成', tone: PresentedStep['tone'] = 'neutral';
  let detail = text(result.reason) || text(error.message);
  if (pending) { state = '等待最终回执'; detail = '整段计划仍在执行，暂未取得此步骤的最终结果。'; }
  else if (status === 'skipped') state = '未执行';
  else if (/indeterminate|unconfirmed|cancelled/.test(status)) { state = '结果未确认'; tone = 'warning'; }
  else if (status === 'failed') { state = '执行失败'; tone = 'error'; }
  else if (status !== 'succeeded') { state = '结果未知'; tone = 'warning'; }
  else if (tool === 'ui_assert') {
    if (result.status === 'passed') { state = '页面检查通过'; tone = 'success'; }
    else if (result.status === 'failed') { state = '页面检查未通过'; tone = 'error'; }
    else { state = '无法判定'; tone = 'warning'; }
  } else if (tool === 'data_read') state = '已读取';
  else if (tool === 'data_write') state = typeof result.revision === 'string' && Object.hasOwn(result, 'value') ? '已保存并回读' : '保存结果待核对';
  else if (tool === 'ui_action' || tool === 'invoke') {
    state = '已派发，业务结果未确认';
    detail ||= '调用回执不代表业务操作完成，请通过明确检查核对实际状态。';
  }
  return { id: text(step.id), label: text(step.label) || toolLabel(tool), tool, status: state, tone,
    result: json(step.result ?? null), detail, logId: text(step.log_id) || null };
}

export function activitySteps(value: JsonValue): readonly PresentedStep[] {
  const item = object(value), response = object(item.response);
  const pending = item.state === 'queued' || item.state === 'delivered';
  if (item.tool === 'automation_run') {
    const completed = array(response.steps);
    return (completed.length ? completed : array(item.steps)).map(step => presentStep(json(step), pending));
  }
  if (!text(item.commandId)) return [];
  return [presentStep({ id: text(item.commandId), tool: text(item.tool),
    status: item.state === 'succeeded' ? 'succeeded' : item.state === 'failed' ? 'failed' : 'indeterminate',
    result: json(item.response ?? null) }, pending)];
}

export function activitySummary(value: JsonValue, stale: boolean): { title: string; description: string; warning: boolean } {
  const item = object(value), response = object(item.response);
  if (stale) return { title: '连接已断开，显示最后一次结果', description: '历史内容仍可查看；当前页面状态尚未确认。', warning: true };
  if (!text(item.commandId)) return { title: '等待第一条调试调用', description: '选定插件的公开调试记录会显示在这里，也可以先手动检查。', warning: false };
  if (item.state === 'queued' || item.state === 'delivered') return { title: '计划执行中', description: '等待最终回执，步骤结果返回后更新。', warning: false };
  if (/unconfirmed/.test(text(item.state)) || response.status === 'indeterminate' || response.status === 'cancelled')
    return { title: '请求已派发，结果尚未确认', description: '先查询原命令结果或读取实际状态，不自动重复执行。', warning: true };
  if (item.state === 'failed' || response.status === 'failed') return { title: '调试结束，存在未通过的步骤', description: '查看步骤结果与日志，再决定下一步检查。', warning: true };
  const passed = activitySteps(value).filter(step => step.status === '页面检查通过').length;
  return { title: passed ? `调试结束 · ${passed}项页面检查通过` : '调试调用已结束',
    description: passed ? '点击步骤查看对应结果；已通过的检查仅覆盖本次明确检查点。' : '调用回执已返回；业务是否完成仍需相应检查确认。', warning: false };
}
