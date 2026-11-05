import type { DebugActionRequest, TreeAssertion, TreeQuery, UiNodeRef, EvidenceState } from '../../plugins/debugger/index.ts';
import type { JsonValue } from '../../plugin-sdk/index.ts';
import { fail, integer, json, keys, object, text, unavailable } from './validation.ts';

function evidence(value: unknown): EvidenceState {
  if (value === 'yes' || value === 'no' || value === 'unknown') return value;
  return fail('invalid_parameters', '证据状态必须是yes、no或unknown');
}
export function query(value: unknown): TreeQuery {
  const input = object(value);
  keys(input, ['id', 'role', 'name', 'surfaceId', 'descendantOf', 'hidden', 'disabled', 'limit']);
  return {
    ...(input.id !== undefined ? { id: text(input.id, '节点标识') } : {}),
    ...(input.role !== undefined ? { role: text(input.role, '角色') } : {}),
    ...(input.name !== undefined ? { name: text(input.name, '名称') } : {}),
    ...(input.surfaceId !== undefined ? { surfaceId: text(input.surfaceId, '表面标识') } : {}),
    ...(input.descendantOf !== undefined ? { descendantOf: text(input.descendantOf, '祖先标识') } : {}),
    ...(input.hidden !== undefined ? { hidden: evidence(input.hidden) } : {}),
    ...(input.disabled !== undefined ? { disabled: evidence(input.disabled) } : {}),
    ...(input.limit !== undefined ? { limit: integer(input.limit, '查询条数', 1, 500) } : {}),
  };
}
export function assertion(value: unknown): TreeAssertion {
  const input = object(value);
  keys(input, ['query', 'condition', 'expected']);
  const match = query(input.query);
  switch (input.condition) {
    case 'count': return { query: match, condition: 'count', expected: integer(input.expected, '预期数量', 0, 500) };
    case 'value_equals':
      if (typeof input.expected !== 'string' || input.expected.length > 16384)
        return fail('invalid_parameters', 'assertion.expected必须是至多16Ki字符的字符串');
      return { query: match, condition: 'value_equals', expected: input.expected };
    case 'selected_equals': {
      if (!Array.isArray(input.expected) || input.expected.length > 100)
        return fail('invalid_parameters', 'assertion.expected必须是至多100项的选项数组');
      const expected: string[] = [];
      for (const value of input.expected) {
        if (typeof value !== 'string' || value.length > 1024)
          return fail('invalid_parameters', 'assertion.expected中的选项必须是至多1024字符的字符串');
        expected.push(value);
      }
      if (new Set(expected).size !== expected.length) return fail('invalid_parameters', 'assertion.expected选项不能重复');
      return { query: match, condition: 'selected_equals', expected };
    }
    case 'exists': case 'absent': case 'enabled': case 'visible': case 'valid':
    case 'in_viewport': case 'within_root': case 'unclipped': case 'nonzero_size':
      if (input.expected !== undefined) fail('invalid_parameters', '只有count、value_equals和selected_equals断言接受expected');
      return { query: match, condition: input.condition };
    default: return fail('invalid_parameters', '不支持的树断言条件');
  }
}

export type UiActionExpectation =
  | { readonly kind: 'ui'; readonly assertion: TreeAssertion; readonly timeout_ms: number }
  | { readonly kind: 'data'; readonly source_id: string; readonly query?: JsonValue;
      readonly checks: readonly { readonly pointer: string; readonly equals: JsonValue }[]; readonly timeout_ms: number };

export function expectation(value: unknown): UiActionExpectation {
  const input = object(value);
  const timeout_ms = input.timeout_ms === undefined ? 3000 : integer(input.timeout_ms, 'expect.timeout_ms', 0, 10000);
  if (input.kind === 'ui') {
    keys(input, ['kind', 'assertion', 'timeout_ms']);
    return { kind: 'ui', assertion: assertion(input.assertion), timeout_ms };
  }
  if (input.kind !== 'data') return fail('invalid_parameters', 'expect.kind必须是ui或data');
  keys(input, ['kind', 'source_id', 'query', 'checks', 'timeout_ms']);
  const source_id = text(input.source_id, 'expect.source_id', 128);
  if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > 16)
    return fail('invalid_parameters', 'expect.checks必须包含1到16项检查');
  const checks = input.checks.map((value) => {
    const check = object(value);
    keys(check, ['pointer', 'equals']);
    if (typeof check.pointer !== 'string' || !check.pointer.startsWith('/') || check.pointer.length > 1024 ||
        /~(?:[^01]|$)/.test(check.pointer))
      return fail('invalid_parameters', 'expect.checks.pointer必须是指向明确字段且至多1024字符的JSON Pointer');
    if (!Object.hasOwn(check, 'equals')) return fail('invalid_parameters', 'expect.checks.equals必须明确提供JSON期望');
    return { pointer: check.pointer, equals: json(check.equals) };
  });
  return { kind: 'data', source_id, checks, timeout_ms,
    ...(input.query === undefined ? {} : { query: json(input.query) }) };
}
function reference(value: unknown): UiNodeRef {
  const input = object(value);
  keys(input, ['id', 'generation', 'revision']);
  return { id: text(input.id, '节点标识'), generation: integer(input.generation, '节点代次', 0, Number.MAX_SAFE_INTEGER),
    revision: integer(input.revision, '节点修订', 0, Number.MAX_SAFE_INTEGER) };
}
export function action(value: unknown): DebugActionRequest {
  const input = object(value);
  keys(input, ['type', 'target', 'confirmed', 'allowUnknownSideEffects', 'value', 'values', 'assertion', 'timeoutMs', 'path']);
  for (const key of ['confirmed', 'allowUnknownSideEffects'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean') fail('invalid_parameters', '动作确认必须为布尔值');
  const confirmed = input.confirmed === true;
  const allowUnknownSideEffects = input.allowUnknownSideEffects === true;
  if (input.type === 'navigate') return { type: 'navigate', path: text(input.path, '导航路径'), confirmed };
  if (input.type === 'wait') return { type: 'wait', assertion: assertion(input.assertion),
    ...(input.timeoutMs !== undefined ? { timeoutMs: integer(input.timeoutMs, '等待毫秒', 0, 10000) } : {}) };
  const target = reference(input.target);
  switch (input.type) {
    case 'highlight': case 'click': case 'scroll': return { type: input.type, target, confirmed, allowUnknownSideEffects };
    case 'fill':
      if (typeof input.value !== 'string' || input.value.length > 16384) return fail('invalid_parameters', '填写值必须是至多16KiB的字符串');
      return { type: 'fill', target, confirmed, allowUnknownSideEffects, value: input.value };
    case 'select': {
      if (!Array.isArray(input.values) || input.values.length > 100) return fail('invalid_parameters', '选项必须是最多100项的数组');
      const values: string[] = [];
      for (const value of input.values) values.push(text(value, '选项', 1024));
      return { type: 'select', target, confirmed, allowUnknownSideEffects, values };
    }
    default: return unavailable('不支持此UI动作，不执行任意脚本');
  }
}
