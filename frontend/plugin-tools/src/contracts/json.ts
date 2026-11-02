export type ContractJson = null | boolean | number | string | ContractJson[] | ContractObject;
export interface ContractObject { [key: string]: ContractJson }

export function invalid(path: string, message: string): never {
  throw new Error(`${path}：${message}`);
}
export function object(value: ContractJson | undefined, path: string): ContractObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(path, '必须是 JSON 对象');
  return value;
}
export function text(value: ContractJson | undefined, path: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(path, '必须是非空字符串');
  return value;
}
export function fields(value: ContractObject, allowed: readonly string[], path: string) {
  for (const name of Object.keys(value))
    if (!allowed.includes(name)) invalid(`${path}.${name}`, '不支持该字段');
}

/** 只接收有界 JSON 数据；拒绝访问器、循环及非有限数，不触发清单中的自定义行为。 */
export function manifestJson(input: unknown): ContractJson {
  const active = new Set<object>();
  let nodes = 0;
  function visit(value: unknown, path: string, depth: number): ContractJson {
    if (++nodes > 20_000 || depth > 40) invalid(path, 'JSON 节点数量或深度超过生成上限');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid(path, 'JSON 数值必须有限');
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > 256 * 1024) invalid(path, 'JSON 字符串超过生成上限');
      return value;
    }
    if (typeof value !== 'object') invalid(path, '只能包含有限 JSON 数据');
    if (active.has(value)) invalid(path, 'JSON 不能循环引用');
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      invalid(path, 'JSON 对象不能使用自定义原型');
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Reflect.ownKeys(value).length !== value.length + 1 ||
            Object.keys(value).length !== value.length)
          invalid(path, 'JSON 数组不能稀疏或携带额外字段');
        return Array.from({ length: value.length }, (_unused, index) => {
          const property = Object.getOwnPropertyDescriptor(value, String(index));
          if (!property || !('value' in property)) invalid(`${path}[${index}]`, 'JSON 数组不能使用访问器');
          const item: unknown = property.value;
          return visit(item, `${path}[${index}]`, depth + 1);
        });
      }
      const entries: [string, ContractJson][] = [];
      for (const name of Reflect.ownKeys(value)) {
        if (typeof name !== 'string') invalid(path, 'JSON 对象不能包含符号字段');
        const property = Object.getOwnPropertyDescriptor(value, name);
        if (!property || !property.enumerable || !('value' in property))
          invalid(`${path}.${name}`, 'JSON 对象只能包含普通可枚举值');
        const item: unknown = property.value;
        entries.push([name, visit(item, `${path}.${name}`, depth + 1)]);
      }
      entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return Object.fromEntries(entries);
    } finally { active.delete(value); }
  }
  const result = visit(input, 'manifest', 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024)
    invalid('manifest', 'JSON 内容超过 1 MiB 生成上限');
  return result;
}

/** 生成 JavaScript 对象字面量；计算属性保留 __proto__ 的普通 JSON 键语义。 */
export function literal(value: ContractJson, indent = 0): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const padding = '  '.repeat(indent), child = padding + '  ';
  if (Array.isArray(value))
    return value.length ? `[\n${value.map((item) => child + literal(item, indent + 1)).join(',\n')}\n${padding}]` : '[]';
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return entries.length ? `{\n${entries.map(([name, item]) =>
    `${child}${name === '__proto__' ? '["__proto__"]' : JSON.stringify(name)}: ${literal(item, indent + 1)}`,
  ).join(',\n')}\n${padding}}` : '{}';
}
