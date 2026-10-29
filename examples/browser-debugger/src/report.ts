import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import type { DebuggerState } from './controller.ts';
import { json, targetKey } from './protocol.ts';

function cachedActivity(state: DebuggerState) {
  const page = state.activity;
  const matches = Boolean(page?.target && state.target && targetKey(page.target) === targetKey(state.target));
  return { page: matches ? page : null,
    detail: matches && page?.items.some((item) => item.commandId === state.activityDetail?.commandId) ? state.activityDetail : null };
}
function targetEvents(state: DebuggerState) {
  return state.events.filter((event) => event.target && state.target && targetKey(event.target) === targetKey(state.target));
}

export function localReport(state: DebuggerState, now = Date.now()): JsonValue {
  const activity = cachedActivity(state);
  return json({ format: 'deviceforge-debugger-ui-v1', exported_at: new Date(now).toISOString(), target: state.target,
    session_id: state.sessionId, session_state: state.sessionState, stale: state.stale,
    last_observed_at: state.tree?.observedAt ?? null, evidence: state.report, inspection: state.inspection,
    cached_trees: state.trees.map((tree) => tree.raw),
    events: targetEvents(state),
    activity: activity.page, activity_detail: activity.detail,
    activity_scope: { read_only: true, retained_only: activity.page?.retainedOnly ?? true,
      gap: activity.page?.gap ?? null, next_before: activity.page?.nextBefore ?? null,
      cached_only: true, description: '仅当前明确目标已缓存的公开调用摘要与选中原回执；未追加查询，不保证完整历史或跨重启保留' },
    log_id: state.logId, limitations: ['仅公开服务返回的证据和本插件内存缓存', '过期快照不代表当前运行状态',
      '可能存在未观测、分页或截断；不是整套安装、设备或生产验收报告', '脱敏不能保证识别所有自由文本中的秘密，请按需分享'] });
}
const md = (value: string) => value.replace(/[\\`*_{}\[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');
export function markdownReport(state: DebuggerState, now = Date.now()): string {
  const target = state.target;
  const activity = cachedActivity(state);
  const lines = ['# DeviceForge 调试报告', '', `导出时间：${new Date(now).toISOString()}`, '',
    `目标：${md(target?.pluginId ?? '未选定')}；类型：${target?.kind ?? '未知'}；代次：${md(target?.generation ?? '未知')}`,
    `实例：${md(target?.instanceId ?? '服务器目标或未提供')}`, `会话状态：${md(state.sessionState)}`,
    `快照：${state.stale ? '已过期，只读，不代表当前运行状态' : '最近一次公开观测'}`, '',
    '## 观测摘要', '', `缓存快照：${state.trees.length}；已加载节点：${state.tree?.nodes.length ?? 0}；事件缓存：${state.events.length}。`,
    `最近日志 ID：${md(state.logId ?? '未提供')}`, '', '## 事件摘要', '',
    '| 序号 | 事件 | 代次 |', '| --- | --- | --- |'];
  for (const event of targetEvents(state))
    lines.push(`| ${event.sequence} | ${md(event.label)} | ${md(event.target?.generation ?? '未知')} |`);
  lines.push('', '## 调试调用摘要', '', '仅已缓存的公开摘要与选中回执；本次导出没有追加查询或重新执行。', '',
    `历史范围：${activity.page?.retainedOnly ? '仅仍保留记录' : '未取得完整性证明'}；${activity.page?.gap ? '存在淘汰缺口' : '未声明淘汰缺口，不代表完整历史'}。`, '',
    '| 调用 | 工具 | 原回执状态 |', '| --- | --- | --- |');
  for (const item of activity.page?.items ?? [])
    lines.push(`| ${md(item.commandId)} | ${md(item.tool)} | ${md(item.state)} |`);
  if (activity.detail) {
    lines.push('', `选中回执：${md(activity.detail.commandId)}；原状态：${md(activity.detail.state)}。`, '',
      '| 步骤 | 展示名称 | 工具 |', '| --- | --- | --- |');
    for (const step of activity.detail.steps)
      lines.push(`| ${md(step.id)} | ${md(step.label ?? step.tool)} | ${md(step.tool)} |`);
  }
  lines.push('', '## 证据范围', '', '仅公开服务和已缓存观测；可能存在未观测、分页或截断。不是完整安装、设备或生产验收报告。', '',
    '## 公开证据', '', '````json', JSON.stringify(localReport(state, now), null, 2).replace(/````/g, '\\u0060\\u0060\\u0060\\u0060'), '````', '');
  return lines.join('\n');
}
export function createDownloads(document: Document) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const urlApi = document.defaultView?.URL;
  function save(blob: Blob, filename: string) {
    if (!urlApi?.createObjectURL) throw new Error('当前浏览器不支持文件下载，请使用宿主报告产物入口');
    const url = urlApi.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.className = 'hidden'; document.body.append(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
    pending.set(url, setTimeout(() => { urlApi.revokeObjectURL(url); pending.delete(url); }, 1000));
  }
  return { save, dispose() { for (const [url, timer] of pending) { clearTimeout(timer); urlApi?.revokeObjectURL(url); } pending.clear(); } };
}
