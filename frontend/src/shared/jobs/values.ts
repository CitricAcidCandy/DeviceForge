import { ApiError } from '../../services/api/errors.ts';
import { isRecord } from '../../services/api/validation.ts';

export type JsonData = null | boolean | number | string | JsonData[] | { [key: string]: JsonData };
// 拒绝循环、非有限数值和非 JSON 对象，避免发送时丢字段或改变值。
export function isJsonData(value: unknown): value is JsonData {
  const ancestors = new Set<object>();
  function check(item: unknown, depth: number): boolean {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || depth > 64 || ancestors.has(item)) return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    if (Object.getOwnPropertySymbols(item).length > 0 || !Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    if (Array.isArray(item) && Object.keys(item).length !== item.length) return false;
    if (Object.entries(Object.getOwnPropertyDescriptors(item)).some(([key, descriptor]) => !(Array.isArray(item) && key === 'length') && (descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable))) return false;
    ancestors.add(item);
    const children: unknown[] = Array.isArray(item) ? Array.from(item) : Object.values(item);
    const valid = children.every((child) => check(child, depth + 1));
    ancestors.delete(item);
    return valid;
  }
  return check(value, 0);
}
export function requireJson(value: unknown): JsonData {
  if (!isJsonData(value)) throw new ApiError('protocol', 'invalid_json_value', '输入须为有限且无循环的 JSON 数据');
  return value;
}
export function invalidBusinessResult(module: string, logId: string | null): ApiError {
  return new ApiError('protocol', 'invalid_business_result', `${module}操作返回了不兼容的业务结果`, null, logId);
}
export const nonemptyText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const naturalNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const decimalU64 = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
export const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
export function jsonObject(value: unknown): value is { [key: string]: JsonData } {
  return isRecord(value) && isJsonData(value);
}
