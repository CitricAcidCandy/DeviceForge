import { HostError } from '../../plugin-sdk/models.ts';
import type { JsonValue } from '../../plugin-sdk/models.ts';
import type { WorkspaceViewRef } from '../../plugin-sdk/workspace.ts';

export function invalid(message: string): never {
  throw new HostError('protocol', 'workspace_invalid', message);
}
export function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,199}$/.test(value);
}
export function requireId(value: unknown): asserts value is string {
  if (!validId(value)) invalid('工作区标识格式无效');
}
export function requireOwnedId(pluginId: string, value: unknown): asserts value is string {
  requireId(value);
  if (!value.startsWith(`${pluginId}.`)) invalid('工作区贡献或实例超出插件命名空间');
}
export function requirePluginId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{0,99}$/.test(value))
    invalid('工作区插件标识格式无效');
}
export function requireTitle(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160)
    invalid('工作区展示名为空或超过长度限制');
}
export function requireRef(value: unknown): asserts value is WorkspaceViewRef {
  if (!record(value)) invalid('工作区视图引用格式无效');
  if (Object.keys(value).some((key) => key !== 'pluginId' && key !== 'viewId')) invalid('工作区视图引用包含未知字段');
  requirePluginId(value.pluginId);
  requireOwnedId(value.pluginId, value.viewId);
}
/** 输入先限定深度与节点数，避免循环或深层对象在克隆时占住宿主。 */
export function requireJson(value: unknown): asserts value is JsonValue {
  let nodes = 0;
  const parents = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 16384 || depth > 32) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 1048576;
    if (typeof item !== 'object' || parents.has(item)) return false;
    if (!Array.isArray(item) && !record(item)) return false;
    parents.add(item);
    const valid = Object.values(item).every((entry) => visit(entry, depth + 1));
    parents.delete(item);
    return valid;
  }
  if (!visit(value, 0)) invalid('工作区数据必须是有界、无循环的 JSON');
}
export function frozen<T>(value: T): T {
  const visit = (item: unknown) => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) visit(child);
    Object.freeze(item);
  };
  visit(value);
  return value;
}
export function clone<T>(value: T): T {
  return frozen(structuredClone(value));
}
export function sameJson(first: JsonValue, second: JsonValue): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}
export function notify(listeners: Iterable<() => void>) {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* 单个消费方不能中断注册表发布。 */ }
  }
}
