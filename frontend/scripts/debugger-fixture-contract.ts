import type { JsonValue } from '../src/plugin-sdk/index.ts';

export const debuggerFixtureIds = {
  provider: 'acceptance.debug-provider', consumer: 'acceptance.debug-consumer',
  official: 'deviceforge_debugger', service: 'acceptance.debug-provider.echo',
  operation: 'plugin.online_echo_v2.echo',
} as const;
export type DebuggerObject = { [key: string]: JsonValue };
function isDebuggerObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function debuggerObject(value: unknown): Record<string, unknown> {
  if (!isDebuggerObject(value)) throw new Error('验收响应必须是对象');
  return value;
}
export function debuggerJson(value: unknown, depth = 0): JsonValue {
  if (depth > 48) throw new Error('验收 JSON 嵌套超限');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => debuggerJson(item, depth + 1));
  return Object.fromEntries(Object.entries(debuggerObject(value)).map(([key, item]) => [key, debuggerJson(item, depth + 1)]));
}
export function debuggerRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('验收响应必须是数组');
  return value.map((item: unknown) => debuggerObject(item));
}
export function debuggerText(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('验收响应缺少非空字符串');
  return value;
}
export class DebuggerReceiptError extends Error {
  readonly state: string;
  readonly code: string;
  readonly logId: string | null;
  constructor(state: string, code: string, logId: string | null) {
    super(`调试回执未成功：${state} ${code}`); this.name = 'DebuggerReceiptError';
    this.state = state; this.code = code; this.logId = logId;
  }
}
/** 未确认的回执只报错，不重新派发原动作。 */
export function debuggerReceipt(value: unknown): Record<string, unknown> {
  const item = debuggerObject(value);
  if (typeof item['command_id'] !== 'string') return item;
  if (item['state'] !== 'succeeded') {
    const response = debuggerObject(item['response'] ?? {});
    const error = debuggerObject(response['error'] ?? {});
    throw new DebuggerReceiptError(String(item['state']), typeof error['code'] === 'string' ? error['code'] : 'result_unconfirmed',
      typeof item['log_id'] === 'string' ? item['log_id'] : null);
  }
  return debuggerObject(item['response']);
}
export function debuggerLoopback(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      !url.port || [7031, 5173, 5186].includes(Number(url.port)) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('验收仅允许独占的本机回环端口，拒绝用户已有服务');
  return url;
}
