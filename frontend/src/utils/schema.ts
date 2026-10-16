import Ajv from 'ajv';

export type SchemaValue = null | boolean | number | string | SchemaValue[] | { [key: string]: SchemaValue };
export interface SchemaIssue { readonly path: string; readonly message: string }

export function isSchemaValue(value: unknown): value is SchemaValue {
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

export function schemaObject(value: SchemaValue | undefined): { [key: string]: SchemaValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function cloneSchemaValue(value: SchemaValue): SchemaValue {
  if (Array.isArray(value)) return value.map(cloneSchemaValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneSchemaValue(child)]));
  return value;
}

export function schemaDefault(schema: SchemaValue): SchemaValue {
  const definition = schemaObject(schema);
  if (definition['default'] !== undefined) return cloneSchemaValue(definition['default']);
  const type = definition['type'];
  if (type === 'object' || definition['properties'])
    return Object.fromEntries(Object.entries(schemaObject(definition['properties'])).map(([key, child]) => [key, schemaDefault(child)]));
  if (type === 'array') return [];
  if (type === 'boolean') return false;
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'null') return null;
  if (Array.isArray(definition['enum']) && definition['enum'][0] !== undefined) return cloneSchemaValue(definition['enum'][0]);
  return '';
}

const validator = new Ajv({ allErrors: true, strict: false, validateFormats: false });
export function validateSchema(schema: SchemaValue, value: SchemaValue): readonly SchemaIssue[] {
  try {
    if (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object' || Array.isArray(schema)))
      return [{ path: '', message: '配置 schema 必须是对象或布尔值' }];
    const validate = validator.compile(schema);
    if (validate(value)) return [];
    return (validate.errors ?? []).map((error) => ({
      path: error.instancePath + (error.keyword === 'required' && typeof error.params['missingProperty'] === 'string' ? `/${error.params['missingProperty']}` : ''),
      message: error.message ?? '字段不符合配置约束',
    }));
  } catch {
    return [{ path: '', message: '配置 schema 无法编译，请联系插件作者' }];
  }
}

export function mapSchemaSecrets(schema: SchemaValue, value: SchemaValue, previous?: SchemaValue, mode: 'mask' | 'restore' = 'mask'): SchemaValue {
  const definition = schemaObject(schema);
  if (definition['writeOnly'] === true || definition['format'] === 'password')
    return mode === 'mask' ? value === null || value === '' ? value : '********' : value === '********' && previous !== undefined ? cloneSchemaValue(previous) : value;
  if (Array.isArray(value)) return value.map((item, index) => mapSchemaSecrets(definition['items'] ?? {}, item, Array.isArray(previous) ? previous[index] : undefined, mode));
  if (value && typeof value === 'object') {
    const properties = schemaObject(definition['properties']);
    const before = schemaObject(previous);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapSchemaSecrets(properties[key] ?? definition['additionalProperties'] ?? {}, item, before[key], mode)]));
  }
  return value;
}

export function readonlyIssues(schema: SchemaValue, previous: SchemaValue, value: SchemaValue, path = ''): readonly SchemaIssue[] {
  const definition = schemaObject(schema);
  if (definition['readOnly'] === true) return JSON.stringify(previous) === JSON.stringify(value) ? [] : [{ path, message: '只读字段不能修改' }];
  if (Array.isArray(value)) return value.flatMap((item, index) => readonlyIssues(definition['items'] ?? {}, Array.isArray(previous) ? previous[index] ?? null : null, item, `${path}/${index}`));
  if (value && typeof value === 'object') {
    const properties = schemaObject(definition['properties']);
    const before = schemaObject(previous);
    return Object.keys({ ...before, ...value }).flatMap((key) => readonlyIssues(properties[key] ?? definition['additionalProperties'] ?? {}, before[key] ?? null, value[key] ?? null, `${path}/${key}`));
  }
  return [];
}

export function redactSchemaDefaults(schema: SchemaValue): SchemaValue {
  if (Array.isArray(schema)) return schema.map(redactSchemaDefaults);
  if (!schema || typeof schema !== 'object') return schema;
  const copied = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, redactSchemaDefaults(value)]));
  if ((schema['writeOnly'] === true || schema['format'] === 'password') && schema['default'] !== undefined)
    copied['default'] = schema['default'] === null || schema['default'] === '' ? schema['default'] : '********';
  return copied;
}

export function hasSchemaFields(schema: SchemaValue): boolean {
  const definition = schemaObject(schema);
  if (definition['type'] === 'object' || definition['properties'] !== undefined)
    return Object.keys(schemaObject(definition['properties'])).length > 0 || (definition['additionalProperties'] !== null && typeof definition['additionalProperties'] === 'object');
  return Object.keys(definition).length > 0;
}
