import { HostError } from '@deviceforge/plugin-sdk';
import type { JsonValue } from '@deviceforge/plugin-sdk';
import type { LogEntry, LogSearch, TaskEvent, TaskProgress } from './types.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const identifier = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
export const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const status = (value: unknown): value is TaskEvent['status'] =>
  value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled';
const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';
export function invalid(message: string, logId: string | null = null): never {
  throw new HostError('protocol', 'invalid_task_response', message, logId);
}
function progress(value: unknown): value is TaskProgress {
  return record(value) &&
    ['preparing', 'downloading', 'verifying', 'deploying', 'activating', 'complete'].includes(String(value.stage)) &&
    nullableText(value.resource_id) && natural(value.completed_bytes) &&
    (value.total_bytes === null || natural(value.total_bytes));
}
/** 原始 HTTP 事件在插件边界显式校验，公开历史接口缺少的进度字段也不能猜测。 */
export function decodeEvents(value: JsonValue, id: string, logId: string | null): readonly TaskEvent[] {
  if (!Array.isArray(value)) invalid('任务事件响应不是数组', logId);
  let previous = 0;
  return Object.freeze(value.map((entry) => {
    if (!record(entry) || entry.job_id !== id || !natural(entry.sequence) || entry.sequence <= previous ||
      !natural(entry.timestamp) || !status(entry.status) ||
      (entry.progress !== undefined && entry.progress !== null && !progress(entry.progress)))
      invalid('任务事件内容、序号或归属不符合公开协议', logId);
    previous = entry.sequence;
    const detail: unknown = entry.progress;
    return Object.freeze({
      sequence: entry.sequence, jobId: id, timestamp: entry.timestamp, status: entry.status,
      ...(progress(detail) ? { progress: Object.freeze({ ...detail }) } : {}),
    });
  }));
}
function logEntry(value: unknown): value is LogEntry {
  return record(value) && typeof value.timestamp === 'string' && typeof value.level === 'string' &&
    typeof value.message === 'string' && value.message.length <= 512 &&
    ['job_id', 'operation', 'code', 'method', 'route'].every((key) => nullableText(value[key])) &&
    (value.log_id == null || (typeof value.log_id === 'string' && identifier(value.log_id))) &&
    (value.job_id === null || (typeof value.job_id === 'string' && identifier(value.job_id))) &&
    (value.status === null || (natural(value.status) && value.status <= 65535));
}
export function decodeLogs(value: JsonValue, logId: string | null): LogSearch {
  if (!record(value) || !(value.log_id === null || (typeof value.log_id === 'string' && identifier(value.log_id))) ||
    typeof value.limited !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 100 ||
    !Array.isArray(value.job_ids) || value.job_ids.length > 20 ||
    !value.job_ids.every((id: unknown): id is string => typeof id === 'string' && identifier(id)) ||
    new Set(value.job_ids).size !== value.job_ids.length)
    invalid('请求日志响应不符合公开协议', logId);
  return Object.freeze({
    log_id: value.log_id, limited: value.limited,
    entries: Object.freeze(value.entries.map((item) => {
      const entry: unknown = item;
      if (!logEntry(entry)) invalid('请求日志条目格式无效', logId);
      return Object.freeze({
      timestamp: entry.timestamp, level: entry.level, message: entry.message,
      job_id: entry.job_id, operation: entry.operation, code: entry.code,
      method: entry.method, route: entry.route, log_id: entry.log_id ?? null, status: entry.status,
      });
    })),
    job_ids: Object.freeze([...value.job_ids]),
  });
}
export function formatJobProgress(value: TaskProgress): string {
  const stages = { preparing: '准备安装', downloading: '下载资源', verifying: '校验资源', deploying: '部署组件', activating: '启用组件', complete: '处理完成' };
  const bytes = value.total_bytes === null ? `${value.completed_bytes.toLocaleString('zh-CN')} 字节` :
    `${value.completed_bytes.toLocaleString('zh-CN')} / ${value.total_bytes.toLocaleString('zh-CN')} 字节`;
  return `${stages[value.stage]}${value.resource_id ? ` · ${value.resource_id}` : ''} · ${bytes}`;
}
