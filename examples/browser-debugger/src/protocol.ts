import type { HostContext, JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';

export type JsonObject = { [key: string]: JsonValue };
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> { return isObject(value) ? value : {}; }
export function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
export function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
export function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function json(value: unknown, depth = 0): JsonValue {
  if (depth > 48) throw new Error('JSON 嵌套超过 48 层');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => json(item, depth + 1));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, depth + 1)]));
  throw new Error('参数必须是有限 JSON');
}
export function parseJson(source: string): JsonValue {
  if (new TextEncoder().encode(source).length > 128 * 1024) throw new Error('JSON 输入不能超过 128 KiB');
  return json(JSON.parse(source));
}
export class DebuggerFailure extends Error {
  readonly code: string;
  readonly logId: string | null;
  readonly unconfirmed: boolean;
  constructor(message: string, code: string, logId: string | null = null, unconfirmed = false) {
    super(message); this.name = 'DebuggerFailure'; this.code = code; this.logId = logId; this.unconfirmed = unconfirmed;
  }
}
export function failure(error: unknown): DebuggerFailure {
  if (error instanceof DebuggerFailure) return error;
  const item = object(error);
  return new DebuggerFailure(error instanceof Error ? error.message : '调试请求失败',
    text(item.code, 'debugger_failed'), text(item.logId) || null,
    /unconfirmed|timeout|cancel/i.test(text(item.code)));
}
export function bounded<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DebuggerFailure('等待已取消或到期；已派发动作的结果需要核对，不会自动重放',
      'debugger_wait_unconfirmed', null, true));
    if (signal.aborted) { void task.catch(() => undefined); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export interface Target {
  readonly kind: 'browser' | 'server';
  readonly instanceId: string | null;
  readonly pluginId: string;
  readonly generation: string | null;
  readonly version: string | null;
}
export const targetKey = (target: Target) => JSON.stringify([target.kind, target.instanceId, target.pluginId, target.generation]);
export function targetInput(target: Target): JsonObject {
  return { target_kind: target.kind, instance_id: target.instanceId, plugin_id: target.pluginId,
    generation: target.generation, version: target.version };
}
export function decodeTarget(value: unknown, instanceId: string | null = null): Target | null {
  const item = object(value);
  const pluginId = text(item.plugin_id);
  if (!pluginId) return null;
  return { kind: item.target_kind === 'server' ? 'server' : 'browser',
    instanceId: text(item.instance_id) || instanceId, pluginId,
    generation: text(item.generation) || null, version: text(item.version) || null };
}
export function decodeDirectory(value: unknown): Target[] {
  const data = object(value);
  const targets: Target[] = [];
  for (const raw of array(data.browser_targets)) {
    const target = decodeTarget(raw); if (target) targets.push(target);
  }
  for (const raw of array(data.browser_instances)) {
    const instance = object(raw);
    for (const plugin of array(instance.plugins)) {
      const target = decodeTarget(plugin, text(instance.instance_id) || null);
      if (target) targets.push(target);
    }
  }
  for (const raw of array(data.server_plugins)) {
    const item = object(raw);
    const pluginId = text(item.id);
    if (pluginId) targets.push({ kind: 'server', instanceId: null, pluginId,
      generation: text(item.generation) || null, version: text(item.version) || null });
  }
  return [...new Map(targets.map((target) => [targetKey(target), target])).values()];
}

export interface UiNode {
  readonly id: string;
  readonly generation: number;
  readonly revision: number;
  readonly parentId: string | null;
  readonly name: string;
  readonly role: string;
  readonly raw: JsonObject;
}
export interface UiTree {
  readonly id: string;
  readonly observedAt: number;
  readonly nodes: readonly UiNode[];
  readonly raw: JsonValue;
}
export function decodeTree(value: unknown): UiTree | null {
  const item = object(value);
  if (!text(item.id) || !Array.isArray(item.nodes)) return null;
  const nodes: UiNode[] = [];
  for (const raw of item.nodes) {
    const node = object(raw);
    if (!text(node.id) || !Number.isSafeInteger(node.generation) || !Number.isSafeInteger(node.revision))
      throw new Error('UI 节点缺少有效的标识、代次或修订');
    const data = json(node);
    if (!isJsonObject(data)) throw new Error('UI 节点不是对象');
    nodes.push({ id: text(node.id), generation: number(node.generation), revision: number(node.revision),
      parentId: text(node.parentId) || null, name: text(node.name), role: text(node.role), raw: data });
  }
  return { id: text(item.id), observedAt: number(item.observedAt), nodes, raw: json(item) };
}
export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export interface Invocation {
  readonly key: string;
  readonly kind: 'command' | 'service' | 'operation';
  readonly id: string;
  readonly version: string | null;
  readonly schema: JsonValue;
  readonly available: boolean;
  readonly reason: string;
}
export function invocations(value: unknown): Invocation[] {
  const item = object(value), catalog = object(item.catalog);
  const result: Invocation[] = [];
  for (const raw of array(catalog.commands)) {
    const command = object(raw), id = text(command.id);
    if (id) result.push({ key: `command:${id}`, kind: 'command', id, version: null,
      schema: null, available: true, reason: '公开命令未声明输入模式，请填写 JSON' });
  }
  for (const raw of [...array(catalog.services), ...array(item.services)]) {
    const entry = object(raw), service = object(entry.service), contract = object(entry.contract);
    const id = text(entry.id) || text(service.id), version = text(entry.version) || text(service.version);
    if (id && version) result.push({ key: `service:${id}:${version}`, kind: 'service', id, version,
      schema: json(entry.inputSchema ?? contract.input_schema ?? contract.inputSchema ?? null),
      available: entry.available !== false, reason: text(entry.reason) });
  }
  for (const raw of array(item.operations)) {
    const operation = object(raw), id = text(operation.id);
    if (id) result.push({ key: `operation:${id}`, kind: 'operation', id, version: null,
      schema: json(operation.input_schema ?? null), available: true, reason: '服务器操作沿原任务入口执行，返回原任务 ID' });
  }
  return result;
}

export function createGateway(context: Pick<HostContext, 'extensions' | 'signal'>) {
  async function service(action: string, fields: JsonObject, signal: AbortSignal, timeoutMs = 15000) {
    const extensions = context.extensions;
    if (!extensions) throw new DebuggerFailure('宿主未提供公开扩展服务，请升级宿主', 'service_unavailable');
    const current = AbortSignal.any([context.signal, signal, AbortSignal.timeout(timeoutMs)]);
    current.throwIfAborted();
    const response = await bounded(extensions.callService('host.debugger', '1', { action, ...fields }, current), current);
    current.throwIfAborted();
    return response;
  }
  async function call(tool: string, input: JsonObject, signal: AbortSignal, timeoutMs = 15000) {
    const result = await service('call', { name: `deviceforge.debug_${tool}`, input }, signal, timeoutMs);
    const receipt = object(result.data);
    if (typeof receipt.state === 'string' && receipt.state.endsWith('_unconfirmed'))
      throw new DebuggerFailure(text(object(object(receipt.response).error).message,
        '命令等待结束，真实结果未确认；请查询目标状态，不会自动重试'),
        text(object(object(receipt.response).error).code, receipt.state), result.logId, true);
    if (typeof receipt.command_id === 'string') {
      const state = text(receipt.state);
      if (state !== 'succeeded') {
        const error = object(object(receipt.response).error);
        throw new DebuggerFailure(text(error.message, `命令状态：${state || '未知'}；没有确认成功，不会自动重试`),
          text(error.code, state || 'result_unconfirmed'), result.logId,
          state !== 'failed');
      }
      if (receipt.response === undefined) throw new DebuggerFailure('成功回执缺少 response', 'invalid_receipt', result.logId);
      return { data: json(receipt.response), logId: result.logId };
    }
    return result;
  }
  return { service, call };
}
