import { invalid, object } from './json.js';
import type { ContractJson, ContractObject } from './json.js';

const supportedTypes = ['null', 'boolean', 'string', 'number', 'integer', 'object', 'array'];
const annotations = ['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples'];
const stringRules = ['minLength', 'maxLength', 'pattern'];
const numericRules = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const arrayRules = ['items', 'minItems', 'maxItems', 'uniqueItems'];
const objectRules = ['properties', 'required', 'additionalProperties'];
const keywords = ['type', 'enum', 'const', ...annotations, ...stringRules, ...numericRules, ...arrayRules, ...objectRules];

function declaredTypes(schema: ContractObject, path: string): string[] {
  const value = schema.type;
  if (typeof value === 'string' && supportedTypes.includes(value)) return [value];
  if (Array.isArray(value) && value.length === 2 && value.includes('null') &&
      value.every((item) => typeof item === 'string' && supportedTypes.includes(item)) &&
      new Set(value).size === value.length)
    return value.map((item) => typeof item === 'string' ? item : invalid(path, 'type 元素必须是字符串'));
  if (value !== undefined) invalid(`${path}.type`, '只支持单一 JSON 类型或包含 null 的双类型联合');
  if (schema.enum !== undefined || Object.hasOwn(schema, 'const')) return [];
  invalid(`${path}.type`, '必须声明类型、标量 enum 或标量 const；不隐式生成未知类型');
}
function integerBound(schema: ContractObject, name: string, path: string) {
  const value = schema[name];
  if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))
    invalid(`${path}.${name}`, '必须是非负安全整数');
}
function bounds(schema: ContractObject, minimum: string, maximum: string, path: string) {
  integerBound(schema, minimum, path); integerBound(schema, maximum, path);
  const low = schema[minimum], high = schema[maximum];
  if (typeof low === 'number' && typeof high === 'number' && low > high)
    invalid(path, `${minimum} 不能大于 ${maximum}`);
}
function scalar(value: ContractJson, path: string) {
  if (value !== null && typeof value === 'object') invalid(path, '当前只支持标量 enum 和 const');
  return value;
}
function matches(value: ContractJson, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}
function literals(schema: ContractObject, types: readonly string[], path: string): string | null {
  if (schema.enum !== undefined && Object.hasOwn(schema, 'const'))
    invalid(path, '不能同时使用 enum 和 const');
  let values: ContractJson[] | null = null;
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256)
      invalid(`${path}.enum`, '必须包含 1 至 256 个不重复标量');
    values = schema.enum.map((value, index) => scalar(value, `${path}.enum[${index}]`));
  } else if (Object.hasOwn(schema, 'const')) {
    const value = schema.const;
    if (value === undefined) invalid(`${path}.const`, '必须是 JSON 标量');
    values = [scalar(value, `${path}.const`)];
  }
  if (!values) return null;
  const encoded = values.map((value) => JSON.stringify(value));
  if (new Set(encoded).size !== encoded.length) invalid(path, 'enum 包含重复值');
  if (types.length && values.some((value) => !types.some((type) => matches(value, type))))
    invalid(path, 'enum 或 const 不符合声明类型');
  return encoded.sort().join(' | ');
}

function validateRules(schema: ContractObject, types: readonly string[], path: string) {
  for (const keyword of Object.keys(schema))
    if (!keywords.includes(keyword)) invalid(`${path}.${keyword}`, `不支持 Schema 关键字 ${keyword}`);
  for (const name of ['$schema', '$id', '$comment', 'title', 'description'])
    if (schema[name] !== undefined && typeof schema[name] !== 'string')
      invalid(`${path}.${name}`, '注释或标识必须是字符串');
  if (schema.examples !== undefined && !Array.isArray(schema.examples))
    invalid(`${path}.examples`, '必须是 JSON 数组');
  const typedRules: readonly (readonly [readonly string[], readonly string[]])[] = [
    [stringRules, ['string']], [numericRules, ['number', 'integer']],
    [arrayRules, ['array']], [objectRules, ['object']],
  ];
  for (const [names, accepted] of typedRules) {
    if (names.some((name) => schema[name] !== undefined) &&
        !accepted.some((type) => types.includes(type)))
      invalid(path, '类型与 Schema 约束关键字不匹配');
  }
  bounds(schema, 'minLength', 'maxLength', path);
  bounds(schema, 'minItems', 'maxItems', path);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') invalid(`${path}.pattern`, '必须是正则表达式字符串');
    try { new RegExp(schema.pattern, 'u'); } catch { invalid(`${path}.pattern`, '正则表达式无效'); }
  }
  for (const name of numericRules)
    if (schema[name] !== undefined && (typeof schema[name] !== 'number' ||
        (name === 'multipleOf' && Number(schema[name]) <= 0)))
      invalid(`${path}.${name}`, '必须是有限数值；multipleOf 须大于零');
  const low = schema.minimum, high = schema.maximum;
  if (typeof low === 'number' && typeof high === 'number' && low > high)
    invalid(path, 'minimum 不能大于 maximum');
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean')
    invalid(`${path}.uniqueItems`, '必须是布尔值');
}

function objectType(schema: ContractObject, path: string): string {
  const properties = schema.properties === undefined ? {} : object(schema.properties, `${path}.properties`);
  const required = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(required) || required.some((name) => typeof name !== 'string') ||
      new Set(required).size !== required.length)
    invalid(`${path}.required`, '必须是不重复的属性名数组');
  for (const name of required)
    if (typeof name !== 'string' || !Object.hasOwn(properties, name))
      invalid(`${path}.required`, '当前子集要求 required 属性同时声明在 properties 中');
  const additional = schema.additionalProperties === undefined ? true : schema.additionalProperties;
  const lines: string[] = [];
  if (typeof additional !== 'boolean') {
    if (Object.keys(properties).length)
      invalid(`${path}.additionalProperties`, '不支持已命名属性与 Schema 字典混合，以免生成错误索引类型');
    lines.push(`[key: string]: ${schemaType(additional, `${path}.additionalProperties`)};`);
  } else if (additional) lines.push('[key: string]: JsonValue;');
  for (const [name, value] of Object.entries(properties).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    lines.push(`${JSON.stringify(name)}${required.includes(name) ? '' : '?'}: ${schemaType(value, `${path}.properties.${name}`)};`);
  if (!lines.length) lines.push('[key: string]: never;');
  return `{\n${lines.map((line) => '  ' + line.replaceAll('\n', '\n  ')).join('\n')}\n}`;
}

/** 类型表达结构，长度、正则、整数范围等仍由随附原 Schema 在运行期校验。 */
export function schemaType(value: ContractJson, path: string): string {
  const schema = object(value, path);
  for (const keyword of Object.keys(schema))
    if (!keywords.includes(keyword)) invalid(`${path}.${keyword}`, `不支持 Schema 关键字 ${keyword}`);
  const types = declaredTypes(schema, path);
  validateRules(schema, types, path);
  const choices = literals(schema, types, path);
  if (choices !== null) return choices;
  const rendered = types.map((type) => {
    if (type === 'object') return objectType(schema, path);
    if (type === 'array') {
      if (schema.items === undefined) invalid(`${path}.items`, '数组必须显式声明元素 Schema');
      return `Array<${schemaType(schema.items, `${path}.items`)}>`;
    }
    return type === 'integer' ? 'number' : type;
  });
  return rendered.sort().join(' | ');
}
