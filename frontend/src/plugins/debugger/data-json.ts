import type { JsonValue } from '../../plugin-sdk/models.ts';
import { HostError } from '../../plugin-sdk/models.ts';
import { maskDataSecrets } from './data-schema.ts';
import { redactText } from './privacy.ts';

export const DATA_BYTES = 256 * 1024;
export function isDataSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
  return ['token', 'accesstoken', 'refreshtoken', 'authorization', 'cookie', 'cookies', 'password', 'passwd',
    'secret', 'credential', 'credentials', 'apikey', 'privatekey'].includes(normalized) ||
    /token$|password$|secret$|apikey$|privatekey$/.test(normalized);
}
export function dataError(code: string, message: string): never {
  throw new HostError('protocol', `debugger_${code}`, message);
}

// 属性描述符检查先于复制，不执行插件 getter、toJSON 或类实例方法。
export function copyDataJson(value: unknown, redact = false, maxBytes = DATA_BYTES): JsonValue {
  const ancestors = new Set<object>();
  let entries = 0;
  let stringBytes = 0;
  function visit(input: unknown, depth: number): JsonValue {
    if (++entries > 8192 || depth > 16) return dataError('limit_exceeded', '调试数据超过深度或节点限额');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string') {
      stringBytes += new TextEncoder().encode(input).byteLength;
      if (stringBytes > maxBytes) return dataError('limit_exceeded', '调试数据超过当前字节限额');
      return redact ? redactText(input) : input;
    }
    if (typeof input !== 'object' || ancestors.has(input)) return dataError('invalid_data', '调试数据必须是有限无循环JSON');
    const prototype: unknown = Object.getPrototypeOf(input);
    if ((!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(input).length)
      return dataError('invalid_data', '调试数据不能包含类实例或符号键');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > 8192) return dataError('limit_exceeded', '调试数据数组超限');
        const output: JsonValue[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !('value' in descriptor)) return dataError('invalid_data', '调试数据不能包含空位或访问器');
          const child: unknown = descriptor.value;
          output.push(visit(child, depth + 1));
        }
        return output;
      }
      const output: { [key: string]: JsonValue } = {};
      for (const key of Object.keys(input)) {
        if (new TextEncoder().encode(key).byteLength > 128) return dataError('limit_exceeded', '调试数据字段名超过128字节');
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) return dataError('invalid_data', '调试数据不能包含访问器');
        const child: unknown = descriptor.value;
        Object.defineProperty(output, key, { enumerable: true,
          value: redact && isDataSecretKey(key) ? '[已脱敏]' : visit(child, depth + 1) });
      }
      return output;
    } finally { ancestors.delete(input); }
  }
  const copied = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(copied)).byteLength > maxBytes)
    return dataError('limit_exceeded', '调试数据超过当前字节限额');
  return copied;
}

export function redactDataValue(schema: JsonValue, value: JsonValue): JsonValue {
  return copyDataJson(maskDataSecrets(schema, value), true);
}

// 公开目录省略敏感声明与所有样本值；完整模式仅保留在本机校验器中。
export function publicDataSchema(schema: JsonValue): { schema: JsonValue; schema_complete: boolean; omitted_schema_paths: string[] } {
  const omitted: string[] = [];
  const pathKey = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
  function visit(value: JsonValue, path: string): JsonValue {
    if (Array.isArray(value)) return value.map((child, index) => visit(child, `${path}/${index}`));
    if (!value || typeof value !== 'object') return typeof value === 'string' ? redactText(value) : value;
    if (value['writeOnly'] === true || value['format'] === 'password') { omitted.push(path || '/'); return {}; }
    const output: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${pathKey(key)}`;
      if (['default', 'examples', 'example'].includes(key)) { omitted.push(childPath); continue; }
      if (isDataSecretKey(key)) { omitted.push(childPath); continue; }
      if (['properties', '$defs', 'definitions', 'patternProperties'].includes(key) && child && typeof child === 'object' && !Array.isArray(child)) {
        const properties: { [key: string]: JsonValue } = {};
        for (const [name, definition] of Object.entries(child)) {
          const propertyPath = `${childPath}/${pathKey(name)}`;
          if (isDataSecretKey(name) || (definition && typeof definition === 'object' && !Array.isArray(definition) &&
            (definition['writeOnly'] === true || definition['format'] === 'password'))) { omitted.push(propertyPath); continue; }
          properties[name] = visit(definition, propertyPath);
        }
        output[key] = properties;
      } else output[key] = visit(child, childPath);
    }
    return output;
  }
  const result = visit(schema, '');
  return { schema: result, schema_complete: omitted.length === 0, omitted_schema_paths: omitted };
}

export function hasSecretData(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(hasSecretData);
  return value !== null && typeof value === 'object' && Object.entries(value).some(([key, child]) => isDataSecretKey(key) || hasSecretData(child));
}

export function hasSecretSchema(schema: JsonValue): boolean {
  if (Array.isArray(schema)) return schema.some(hasSecretSchema);
  if (!schema || typeof schema !== 'object') return false;
  if (schema['writeOnly'] === true || schema['format'] === 'password') return true;
  const properties = schema['properties'];
  if (properties && typeof properties === 'object' && !Array.isArray(properties) && Object.keys(properties).some(isDataSecretKey)) return true;
  return Object.values(schema).some(hasSecretSchema);
}
