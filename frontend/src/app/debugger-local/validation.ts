import { HostError } from '../../plugin-sdk/index.ts';
import type { JsonValue } from '../../plugin-sdk/index.ts';
import type { DebugTarget } from './types.ts';
import { redactText, sensitiveKey } from '../../plugins/debugger/index.ts';

export const MAX_BYTES = 1024 * 1024;
export function fail(code: string, message: string): never {
  throw new HostError('protocol', `debugger_${code}`, message);
}
export function unavailable(message: string): never {
  return fail('capability_unavailable', message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    return fail('invalid_parameters', '参数必须是普通对象');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return fail('invalid_parameters', '参数不能是类实例');
  return value;
}
export function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    return fail('invalid_parameters', `${label}必须是非空且不超过${max}字符的字符串`);
  return value;
}
export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return fail('invalid_parameters', `${label}必须在${min}到${max}之间`);
  return value;
}
export function generation(value: unknown): string {
  const result = text(value, '插件代次', 16);
  if (!/^(0|[1-9]\d*)$/.test(result) || !Number.isSafeInteger(Number(result)))
    return fail('invalid_parameters', '插件代次必须是规范的非负安全整数字符串');
  return result;
}
export function target(value: unknown): DebugTarget {
  const input = object(value);
  const plugin_id = text(input.plugin_id, '插件标识', 100);
  if (!/^[a-z][a-z0-9._-]*$/.test(plugin_id)) return fail('invalid_parameters', '插件标识无效');
  return { plugin_id, generation: input.generation === null ? null : generation(input.generation) };
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail('invalid_parameters', '参数含有不受支持的字段');
}

// 通过属性描述符读取未知边界，拒绝访问器、循环、非 JSON 和超量结构，不执行 toJSON。
export function json(value: unknown, redact = false): JsonValue {
  const ancestors = new Set<object>();
  let entries = 0;
  let stringBytes = 0;
  function visit(input: unknown, depth: number): JsonValue {
    if (++entries > 120000 || depth > 32) return fail('limit_exceeded', 'JSON结构超出限额');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string') {
      stringBytes += new TextEncoder().encode(input).byteLength;
      if (stringBytes > MAX_BYTES) return fail('limit_exceeded', 'JSON字符串总量超过1MiB');
      return redact ? redactText(input) : input;
    }
    if (typeof input !== 'object' || input === null || ancestors.has(input))
      return fail('invalid_parameters', '只支持有限、无循环的JSON数据');
    if (Object.getOwnPropertySymbols(input).length) return fail('invalid_parameters', '不支持符号键');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > 10000) return fail('limit_exceeded', 'JSON数组超出限额');
        const result: JsonValue[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !('value' in descriptor)) return fail('invalid_parameters', '数组不能有空位或访问器');
          const entry: unknown = descriptor.value;
          result.push(visit(entry, depth + 1));
        }
        return result;
      }
      const source = object(input);
      const result: { [key: string]: JsonValue } = {};
      for (const key of Object.keys(source)) {
        if (key.length > 1024) return fail('limit_exceeded', 'JSON字段名超出限额');
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor || !('value' in descriptor)) return fail('invalid_parameters', 'JSON不能包含访问器');
        const entry: unknown = descriptor.value;
        const sensitive = sensitiveKey.test(key);
        Object.defineProperty(result, key, { enumerable: true, value: redact && sensitive ? '[已脱敏]' : visit(entry, depth + 1) });
      }
      return result;
    } finally { ancestors.delete(input); }
  }
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BYTES)
    return fail('limit_exceeded', 'JSON响应或参数超过1MiB');
  return result;
}

export async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal, mutation: boolean, timeoutMs = 10000): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      stop();
      reject(new HostError('cancelled', mutation ? 'debugger_result_unconfirmed' : 'debugger_cancelled',
        mutation ? '等待已撤销，变更结果未确认；不会自动重放' : '调试等待已撤销'));
    };
    const timer = setTimeout(() => {
      stop();
      reject(new HostError('protocol', mutation ? 'debugger_result_unconfirmed' : 'debugger_timeout',
        mutation ? '等待到期，变更结果未确认；不会自动重放' : '调试等待到期'));
    }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
      (result) => { stop(); resolve(result); }, (error: unknown) => { stop(); reject(error); },
    );
  });
}
