import type { JsonValue } from '../../plugin-sdk/models.ts';
import type { DebugMetadata, DebugOwner } from '../../plugin-sdk/debug.ts';
import { redactText, sensitiveKey } from './privacy.ts';

export const MAX_BYTES = 1024 * 1024;
export const MAX_NODES = 500;
export const MAX_SNAPSHOTS = 10;
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
export function text(value: string, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${label}必须是非空且不超过${max}字符的字符串`);
  return value;
}
export function copyOwner(owner: DebugOwner): DebugOwner {
  text(owner.pluginId, '插件标识');
  if (!Number.isSafeInteger(owner.generation) || owner.generation < 0)
    throw new Error('插件代次必须是非负安全整数');
  if (owner.instanceId !== undefined) text(owner.instanceId, '实例标识');
  return Object.freeze({ pluginId: owner.pluginId, generation: owner.generation,
    ...(owner.instanceId !== undefined ? { instanceId: owner.instanceId } : {}) });
}

// 仅复制调用者主动交付的 JSON 数据；拒绝 getter、toJSON、循环与非有限数字。
export function copyMetadata(value: unknown = {}): DebugMetadata {
  let entries = 0;
  const seen = new Set<object>();
  function copy(input: unknown, depth: number): JsonValue {
    if (++entries > 2048 || depth > 12) throw new Error('调试元数据结构超过限额');
    if (typeof input === 'string') return redactText(input);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || input === null || seen.has(input))
      throw new Error('调试元数据必须可序列化为 JSON');
    const prototype: unknown = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null)
      throw new Error('调试元数据不能包含类实例');
    if (Object.getOwnPropertySymbols(input).length) throw new Error('调试元数据不能包含符号键');
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        const result: JsonValue[] = [];
        for (let i = 0; i < input.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
          if (!descriptor || !('value' in descriptor)) throw new Error('调试元数据不能包含空位或访问器');
          const item: unknown = descriptor.value;
          result.push(copy(item, depth + 1));
        }
        return result;
      }
      const result: { [key: string]: JsonValue } = {};
      for (const key of Object.keys(input)) {
        if (sensitiveKey.test(key))
          throw new Error('调试元数据包含禁止登记的敏感字段');
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('调试元数据不能包含访问器');
        const item: unknown = descriptor.value;
        Object.defineProperty(result, key, { value: copy(item, depth + 1), enumerable: true });
      }
      return result;
    } finally { seen.delete(input); }
  }
  const copied = copy(value, 0);
  if (copied === null || typeof copied !== 'object' || Array.isArray(copied))
    throw new Error('调试元数据必须为 JSON 对象');
  if (jsonBytes(copied) > 16384) throw new Error('调试元数据超过16KiB');
  return copied;
}

export function freezeJson<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) freezeJson(entry);
  }
  return value;
}
