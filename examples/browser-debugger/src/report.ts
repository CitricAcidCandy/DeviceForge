import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import type { DebuggerState } from './controller.ts';
import { json } from './protocol.ts';

export function localReport(state: DebuggerState, now = Date.now()): JsonValue {
  return json({ format: 'deviceforge-debugger-ui-v1', exported_at: new Date(now).toISOString(), target: state.target,
    session_id: state.sessionId, session_state: state.sessionState, stale: state.stale,
    last_observed_at: state.tree?.observedAt ?? null, evidence: state.report, inspection: state.inspection,
    cached_trees: state.trees.map((tree) => tree.raw),
    events: state.events.filter((event) => event.target?.pluginId === state.target?.pluginId),
    log_id: state.logId, limitations: ['仅公开服务返回的证据和本插件内存缓存', '过期快照不代表当前运行状态',
      '可能存在未观测、分页或截断；不是整套安装、设备或生产验收报告', '脱敏不能保证识别所有自由文本中的秘密，请按需分享'] });
}
const md = (value: string) => value.replace(/[\\`*_{}\[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');
export function markdownReport(state: DebuggerState, now = Date.now()): string {
  const target = state.target;
  const lines = ['# DeviceForge 调试报告', '', `导出时间：${new Date(now).toISOString()}`, '',
    `目标：${md(target?.pluginId ?? '未选定')}；类型：${target?.kind ?? '未知'}；代次：${md(target?.generation ?? '未知')}`,
    `实例：${md(target?.instanceId ?? '服务器目标或未提供')}`, `会话状态：${md(state.sessionState)}`,
    `快照：${state.stale ? '已过期，只读，不代表当前运行状态' : '最近一次公开观测'}`, '',
    '## 观测摘要', '', `缓存快照：${state.trees.length}；已加载节点：${state.tree?.nodes.length ?? 0}；事件缓存：${state.events.length}。`,
    `最近日志 ID：${md(state.logId ?? '未提供')}`, '', '## 事件摘要', '',
    '| 序号 | 事件 | 代次 |', '| --- | --- | --- |'];
  for (const event of state.events.filter((item) => item.target?.pluginId === target?.pluginId))
    lines.push(`| ${event.sequence} | ${md(event.label)} | ${md(event.target?.generation ?? '未知')} |`);
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
