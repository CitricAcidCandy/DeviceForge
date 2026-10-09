import type { JsonValue } from './index.ts';

// 公开插件边界可能接收到类实例或循环引用，不能将其视为 JSON 对象。
export function isJsonValue(value: unknown): value is JsonValue {
  const ancestors = new Set<object>();
  function visit(item: unknown): boolean {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    ancestors.add(item);
    const valid = (Array.isArray(item) ? item : Object.values(item)).every(visit);
    ancestors.delete(item);
    return valid;
  }
  return visit(value);
}
