import { Ajv } from 'ajv';

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

// 安全注解沿本地引用与组合结构合并。分支暂未选中时仍保留保护，避免草稿切换时泄漏。
function schemaBranches(schema: SchemaValue, root: SchemaValue, seen = new Set<SchemaValue>()): readonly SchemaValue[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || seen.has(schema)) return [];
  const next = new Set(seen).add(schema);
  const branches: SchemaValue[] = [schema];
  const reference = schema['$ref'];
  if (typeof reference === 'string' && (reference === '#' || reference.startsWith('#/'))) {
    let target: SchemaValue | undefined = root;
    for (const segment of reference === '#' ? [] : reference.slice(2).split('/')) {
      const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
      target = schemaObject(target)[key];
    }
    if (target !== undefined) branches.push(...schemaBranches(target, root, next));
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const children = schema[keyword];
    if (Array.isArray(children)) for (const child of children) branches.push(...schemaBranches(child, root, next));
  }
  for (const keyword of ['then', 'else']) {
    const child = schema[keyword];
    if (child !== undefined) branches.push(...schemaBranches(child, root, next));
  }
  return branches;
}

function childSchema(branches: readonly SchemaValue[], key: string | number): SchemaValue {
  const children: SchemaValue[] = [];
  for (const branch of branches) {
    const definition = schemaObject(branch);
    if (typeof key === 'number') {
      const items = definition['items'];
      const child = Array.isArray(items) ? items[key] ?? definition['additionalItems'] : items;
      if (child !== undefined) children.push(child);
    } else {
      const properties = schemaObject(definition['properties']);
      let matched = false;
      if (properties[key] !== undefined) { children.push(properties[key]); matched = true; }
      for (const [pattern, child] of Object.entries(schemaObject(definition['patternProperties']))) {
        try { if (new RegExp(pattern).test(key)) { children.push(child); matched = true; } } catch { /* 非法模式由校验器报告。 */ }
      }
      if (!matched && definition['additionalProperties'] !== undefined) children.push(definition['additionalProperties']);
    }
  }
  return { allOf: children };
}

function secretBranches(branches: readonly SchemaValue[]): boolean {
  return branches.some((branch) => { const definition = schemaObject(branch); return definition['writeOnly'] === true || definition['format'] === 'password'; });
}

export function schemaSensitivePaths(schema: SchemaValue, value: SchemaValue, path = '', root = schema): readonly string[] {
  const branches = schemaBranches(schema, root);
  if (secretBranches(branches)) return [path];
  if (Array.isArray(value)) return value.flatMap((item, index) => schemaSensitivePaths(childSchema(branches, index), item, `${path}/${index}`, root));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => schemaSensitivePaths(childSchema(branches, key), item,
    `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, root));
  return [];
}

// 历史修订只记录字段位置；插件升级移除字段注解后，已有敏感值仍不能回显。
export function mapSensitivePaths(value: SchemaValue, paths: readonly string[], previous?: SchemaValue, mode: 'mask' | 'restore' = 'mask'): SchemaValue {
  const sensitive = new Set(paths);
  function visit(item: SchemaValue, before: SchemaValue | undefined, path: string): SchemaValue {
    if (sensitive.has(path)) return mode === 'mask' ? item === null || item === '' ? item : '********'
      : item === '********' && before !== undefined ? cloneSchemaValue(before) : item;
    if (Array.isArray(item)) return item.map((child, index) => visit(child, Array.isArray(before) ? before[index] : undefined, `${path}/${index}`));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
      visit(child, schemaObject(before)[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)]));
    return item;
  }
  return visit(value, previous, '');
}

export function mapSchemaSecrets(schema: SchemaValue, value: SchemaValue, previous?: SchemaValue, mode: 'mask' | 'restore' = 'mask', root = schema): SchemaValue {
  const branches = schemaBranches(schema, root);
  if (secretBranches(branches))
    return mode === 'mask' ? value === null || value === '' ? value : '********' : value === '********' && previous !== undefined ? cloneSchemaValue(previous) : value;
  if (Array.isArray(value)) return value.map((item, index) => mapSchemaSecrets(childSchema(branches, index), item, Array.isArray(previous) ? previous[index] : undefined, mode, root));
  if (value && typeof value === 'object') {
    const before = schemaObject(previous);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapSchemaSecrets(childSchema(branches, key), item, before[key], mode, root)]));
  }
  return value;
}

export function readonlyIssues(schema: SchemaValue, previous: SchemaValue | undefined, value: SchemaValue | undefined, path = '', root = schema): readonly SchemaIssue[] {
  const branches = schemaBranches(schema, root);
  if (branches.some((branch) => schemaObject(branch)['readOnly'] === true))
    return JSON.stringify(previous) === JSON.stringify(value) ? [] : [{ path, message: '只读字段不能修改' }];
  if (Array.isArray(value) || Array.isArray(previous)) {
    const before = Array.isArray(previous) ? previous : [];
    const after = Array.isArray(value) ? value : [];
    return Array.from({ length: Math.max(before.length, after.length) }, (_, index) => index)
      .flatMap((index) => readonlyIssues(childSchema(branches, index), before[index], after[index], `${path}/${index}`, root));
  }
  if ((value && typeof value === 'object') || (previous && typeof previous === 'object')) {
    const before = schemaObject(previous);
    const after = schemaObject(value);
    return Object.keys({ ...before, ...after }).flatMap((key) => readonlyIssues(childSchema(branches, key), before[key], after[key],
      `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, root));
  }
  return [];
}

export function redactSchemaDefaults(schema: SchemaValue, root = schema): SchemaValue {
  if (Array.isArray(schema)) return schema.map((child) => redactSchemaDefaults(child, root));
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key,
    key === 'default' ? mapSchemaSecrets(schema, value, undefined, 'mask', root) : redactSchemaDefaults(value, root)]));
}

export function hasSchemaFields(schema: SchemaValue): boolean {
  return schemaBranches(schema, schema).some((branch) => {
    const definition = schemaObject(branch);
    if (Object.keys(schemaObject(definition['properties'])).length > 0) return true;
    const additional = definition['additionalProperties'];
    if (additional === true || (additional !== null && typeof additional === 'object' && !Array.isArray(additional))) return true;
    return (definition['type'] !== undefined && definition['type'] !== 'object') || Array.isArray(definition['enum']);
  });
}
