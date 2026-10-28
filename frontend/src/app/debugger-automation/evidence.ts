import type { JsonValue } from '../../plugin-sdk/index.ts';
import { HostError } from '../../plugin-sdk/index.ts';
import { isDataSecretKey, redactText } from '../../plugins/debugger/index.ts';
import { fail, json, object } from '../debugger-local/validation.ts';
import type { AutomationStep } from './parameters.ts';

export type StepState = 'succeeded' | 'failed' | 'indeterminate' | 'cancelled' | 'skipped';
export interface BindingEvidence {
  readonly node?: JsonValue;
  readonly rootId?: string;
  readonly revision?: string;
  readonly sourceId?: string;
}
export function bindingEvidence(tool: string, value: JsonValue, parameters: JsonValue): BindingEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  if (tool === 'data_read' && typeof value.revision === 'string' && typeof value.source_id === 'string')
    return { revision: value.revision, sourceId: value.source_id };
  if (tool !== 'ui_query' || !Array.isArray(value.nodes) || value.nodes.length !== 1 || value.complete !== true) return {};
  const node = value.nodes[0];
  if (node === null || typeof node !== 'object' || Array.isArray(node) ||
    typeof node.id !== 'string' || !Number.isSafeInteger(node.generation) || !Number.isSafeInteger(node.revision)) return {};
  const rootId = object(parameters).root_id;
  return { node: { id: node.id, generation: node.generation ?? null, revision: node.revision ?? null },
    ...(typeof rootId === 'string' ? { rootId } : {}) };
}
export function bindParameters(step: AutomationStep, results: ReadonlyMap<string, BindingEvidence>): JsonValue {
  const parameters = { ...object(json(step.parameters)) };
  if (step.bind.target_from_step) {
    const evidence = results.get(step.bind.target_from_step);
    if (!evidence?.node) return fail('binding_unavailable', '查询未取得唯一且完整的节点证据，未派发动作');
    const action = object(parameters.action);
    if (action.target !== undefined) return fail('invalid_parameters', '不能同时指定固定节点和来源步骤');
    if (evidence.rootId !== parameters.root_id && parameters.root_id !== undefined)
      return fail('binding_unavailable', '节点查询与动作不属于同一挂载根');
    if (evidence.rootId !== undefined) parameters.root_id = evidence.rootId;
    parameters.action = { ...action, target: evidence.node };
  }
  if (step.bind.revision_from_step) {
    const evidence = results.get(step.bind.revision_from_step);
    if (!evidence?.revision || evidence.sourceId !== parameters.source_id)
      return fail('binding_unavailable', '读取修订不属于当前数据源，未派发写入');
    if (parameters.expected_revision !== undefined) return fail('invalid_parameters', '不能同时指定固定修订和来源步骤');
    parameters.expected_revision = evidence.revision;
  }
  return json(parameters);
}
export function resultState(value: JsonValue): StepState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'succeeded';
  if (value.error !== undefined || ['failed', 'rejected', 'root_required', 'not_instantiated'].includes(String(value.status))) return 'failed';
  if (['indeterminate', 'timed_out_unconfirmed', 'cancelled_unconfirmed'].includes(String(value.status))) return 'indeterminate';
  if (value.status === 'cancelled') return 'cancelled';
  return 'succeeded';
}
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof HostError && error.code.startsWith('debugger_')
    ? { code: error.code, message: redactText(error.message).slice(0, 512) }
    : { code: 'debugger_step_unconfirmed', message: '调试步骤未能确认，请读取实际状态；不会自动重放' };
}
export function logId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\u0000-\u001f]/.test(value)
    ? redactText(value) : null;
}
// 数据源已按Schema脱敏；此处保留普通业务value字段，再过滤已知凭据字段和文本模式。
export function publicEvidence(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(publicEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, isDataSecretKey(key) || key === 'props' ? '[已脱敏]' : publicEvidence(child)]));
  return value;
}
