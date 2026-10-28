import type { DebugActionRequest, TreeAssertion, TreeQuery, UiNodeRef, EvidenceState } from '../../plugins/debugger/index.ts';
import { fail, integer, keys, object, text, unavailable } from './validation.ts';

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
    case 'exists': case 'absent': case 'enabled': case 'visible': case 'valid':
    case 'in_viewport': case 'within_root': case 'unclipped': case 'nonzero_size':
      if (input.expected !== undefined) fail('invalid_parameters', '只有count断言接受expected');
      return { query: match, condition: input.condition };
    default: return fail('invalid_parameters', '不支持的树断言条件');
  }
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
