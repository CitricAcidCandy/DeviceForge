import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import { array, isJsonObject, json, object, text } from './protocol.ts';

export function schemaDefault(schema: JsonValue, depth = 0): JsonValue {
  const item = object(schema);
  if (item.default !== undefined) return json(item.default);
  if (item.const !== undefined) return json(item.const);
  if (array(item.enum).length) return json(array(item.enum)[0]);
  if (depth > 12) return null;
  if (item.type === 'object' || item.properties) {
    const required = new Set(array(item.required));
    return Object.fromEntries(Object.entries(object(item.properties)).filter(([key, value]) =>
      required.has(key) || object(value).default !== undefined).map(([key, value]) => [key, schemaDefault(json(value), depth + 1)]));
  }
  if (item.type === 'array') return [];
  if (item.type === 'boolean') return false;
  if (item.type === 'number' || item.type === 'integer') return typeof item.minimum === 'number' ? item.minimum : 0;
  if (item.type === 'null') return null;
  return item.type === 'string' ? '' : {};
}
export function validateInput(value: JsonValue, schema: JsonValue, path = '输入', depth = 0): string[] {
  if (schema === false) return [`${path}不接受任何值`];
  if (depth > 32) return [`${path}模式嵌套过深，请使用简化参数`];
  const item = object(schema), errors: string[] = [];
  if (Array.isArray(item.enum) && !item.enum.some((entry: unknown) => JSON.stringify(entry) === JSON.stringify(value))) errors.push(`${path}必须来自枚举`);
  if (item.const !== undefined && JSON.stringify(item.const) !== JSON.stringify(value)) errors.push(`${path}必须符合固定值`);
  const types = Array.isArray(item.type) ? item.type : typeof item.type === 'string' ? [item.type] : [];
  const matches = (kind: unknown) => kind === 'null' ? value === null : kind === 'array' ? Array.isArray(value)
    : kind === 'object' ? isJsonObject(value) : kind === 'integer' ? typeof value === 'number' && Number.isInteger(value) : typeof value === kind;
  if (types.length && !types.some(matches)) return [`${path}类型应为 ${types.join(' / ')}`];
  if (isJsonObject(value)) {
    const properties = object(item.properties);
    for (const key of array(item.required)) if (typeof key === 'string' && !(key in value)) errors.push(`${path}.${key}为必填项`);
    for (const [key, child] of Object.entries(value)) {
      if (properties[key] !== undefined) errors.push(...validateInput(child, json(properties[key]), `${path}.${key}`, depth + 1));
      else if (item.additionalProperties === false) errors.push(`${path}.${key}不允许额外字段`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof item.minItems === 'number' && value.length < item.minItems) errors.push(`${path}条目不足`);
    if (typeof item.maxItems === 'number' && value.length > item.maxItems) errors.push(`${path}条目过多`);
    if (item.items !== undefined) value.forEach((child, index) => errors.push(...validateInput(child, json(item.items), `${path}[${index}]`, depth + 1)));
  }
  if (typeof value === 'number') {
    if (typeof item.minimum === 'number' && value < item.minimum) errors.push(`${path}小于 ${item.minimum}`);
    if (typeof item.maximum === 'number' && value > item.maximum) errors.push(`${path}大于 ${item.maximum}`);
  }
  if (typeof value === 'string') {
    if (typeof item.minLength === 'number' && [...value].length < item.minLength) errors.push(`${path}长度不足`);
    if (typeof item.maxLength === 'number' && [...value].length > item.maxLength) errors.push(`${path}长度超限`);
    // 正则和组合模式仍交给原公开服务校验，不执行插件声明中的任意正则。
  }
  return errors;
}
export function simpleSchema(schema: JsonValue) {
  const item = object(schema);
  return !item.$ref && !item.anyOf && !item.oneOf && !item.allOf &&
    (item.type === 'object' || item.properties !== undefined);
}
export const schemaLabel = (schema: JsonValue) => text(object(schema).title) || text(object(schema).description);
