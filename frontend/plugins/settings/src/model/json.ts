import { HostError } from '@deviceforge/plugin-sdk';
import type { JsonData } from './types.ts';

export function isJsonData(value: unknown): value is JsonData {
  let count = 0;
  const ancestors = new Set<object>();
  function check(item: unknown, depth: number): boolean {
    if (++count > 65536 || depth > 64) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    if (Object.getOwnPropertySymbols(item).length ||
      (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)) return false;
    if (Array.isArray(item) && Object.keys(item).length !== item.length) return false;
    if (Object.entries(Object.getOwnPropertyDescriptors(item)).some(([key, descriptor]) =>
      !(Array.isArray(item) && key === 'length') &&
      (descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable))) return false;
    ancestors.add(item);
    const valid = Object.values(item).every((child) => check(child, depth + 1));
    ancestors.delete(item);
    return valid;
  }
  return check(value, 0);
}
export function jsonObject(value: unknown): value is { [key: string]: JsonData } {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonData(value);
}
export const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
export const decimalU64 = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
export function requireJson(value: unknown): JsonData {
  if (!isJsonData(value)) throw new HostError('protocol', 'invalid_json_value', '输入须为有限且无循环的 JSON 数据');
  return value;
}
export function invalidBusinessResult(module: string, logId: string | null): HostError {
  return new HostError('protocol', 'invalid_business_result', `${module}操作返回了不兼容的业务结果`, logId);
}
/** 配置操作不发布产物，拒绝额外产物而非静默丢弃。 */
export function decodeEmptyArtifactResult(value: unknown, module: string, logId: string | null): unknown {
  if (!jsonObject(value) || !onlyKeys(value, ['result', 'artifacts']) ||
      !Object.hasOwn(value, 'result') || !Array.isArray(value.artifacts) || value.artifacts.length)
    throw invalidBusinessResult(module, logId);
  return value.result;
}
