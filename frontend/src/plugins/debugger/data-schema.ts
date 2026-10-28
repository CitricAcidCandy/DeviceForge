import type { JsonValue } from '../../plugin-sdk/models.ts';

function object(value: JsonValue | undefined): { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// 本地引用及组合分支采用保守并集，未知分支也不能丢失敏感或只读注解。
function branches(schema: JsonValue, root: JsonValue, seen = new Set<JsonValue>()): readonly JsonValue[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || seen.has(schema)) return [];
  const next = new Set(seen).add(schema);
  const result: JsonValue[] = [schema];
  const reference = schema['$ref'];
  if (typeof reference === 'string' && (reference === '#' || reference.startsWith('#/'))) {
    let target: JsonValue | undefined = root;
    for (const segment of reference === '#' ? [] : reference.slice(2).split('/'))
      target = object(target)[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
    if (target !== undefined) result.push(...branches(target, root, next));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const children = schema[key];
    if (Array.isArray(children)) for (const child of children) result.push(...branches(child, root, next));
  }
  for (const key of ['then', 'else']) {
    const child = schema[key];
    if (child !== undefined) result.push(...branches(child, root, next));
  }
  return result;
}

function childSchema(definitions: readonly JsonValue[], key: string | number): JsonValue {
  const result: JsonValue[] = [];
  for (const definition of definitions) {
    const record = object(definition);
    if (typeof key === 'number') {
      const items = record['items'];
      const child = Array.isArray(items) ? items[key] ?? record['additionalItems'] : items;
      if (child !== undefined) result.push(child);
    } else {
      let matched = false;
      const property = object(record['properties'])[key];
      if (property !== undefined) { result.push(property); matched = true; }
      for (const [pattern, child] of Object.entries(object(record['patternProperties']))) {
        if (new RegExp(pattern).test(key)) { result.push(child); matched = true; }
      }
      if (!matched && record['additionalProperties'] !== undefined) result.push(record['additionalProperties']);
    }
  }
  return { allOf: result };
}

export function maskDataSecrets(schema: JsonValue, value: JsonValue, root = schema): JsonValue {
  const definitions = branches(schema, root);
  if (definitions.some(item => object(item)['writeOnly'] === true || object(item)['format'] === 'password')) return '[已脱敏]';
  if (Array.isArray(value)) return value.map((child, index) => maskDataSecrets(childSchema(definitions, index), child, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, maskDataSecrets(childSchema(definitions, key), child, root)]));
  return value;
}

export function changedReadonlyData(schema: JsonValue, before: JsonValue | undefined, after: JsonValue | undefined, root = schema): boolean {
  const definitions = branches(schema, root);
  if (definitions.some(item => object(item)['readOnly'] === true)) return JSON.stringify(before) !== JSON.stringify(after);
  if (Array.isArray(before) || Array.isArray(after)) {
    const previous = Array.isArray(before) ? before : [];
    const current = Array.isArray(after) ? after : [];
    for (let index = 0; index < Math.max(previous.length, current.length); index++)
      if (changedReadonlyData(childSchema(definitions, index), previous[index], current[index], root)) return true;
    return false;
  }
  if ((before && typeof before === 'object') || (after && typeof after === 'object')) {
    const previous = object(before), current = object(after);
    return Object.keys({ ...previous, ...current }).some(key => changedReadonlyData(childSchema(definitions, key), previous[key], current[key], root));
  }
  return false;
}
