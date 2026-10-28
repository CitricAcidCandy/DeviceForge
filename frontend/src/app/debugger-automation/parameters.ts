import type { JsonValue } from '../../plugin-sdk/index.ts';
import { fail, json, keys, object, text } from '../debugger-local/validation.ts';
import { action, assertion, query } from '../debugger-local/ui-parameters.ts';

export interface AutomationStep {
  readonly id: string;
  readonly tool: string;
  readonly parameters: JsonValue;
  readonly bind: { readonly target_from_step?: string; readonly revision_from_step?: string };
}
export interface AutomationPlan {
  readonly steps: readonly AutomationStep[];
  readonly stopOnFailure: boolean;
}
export const mutationTools = new Set(['ui_action', 'data_write', 'invoke']);
const tools = new Set(['inspect', 'data_catalog', 'data_read', 'ui_tree', 'ui_query', 'ui_assert', ...mutationTools]);

function preflight(tool: string, value: JsonValue, targetBinding: boolean, revisionBinding: boolean): void {
  const input = object(value);
  if (tool === 'inspect' || tool === 'data_catalog') { keys(input, []); return; }
  if (tool === 'data_read' || tool === 'data_write') {
    keys(input, tool === 'data_read' ? ['source_id', 'query'] : ['source_id', 'expected_revision', 'value', 'confirmed']);
    text(input.source_id, '数据源标识', 128);
    if (tool === 'data_write') {
      if (!revisionBinding) text(input.expected_revision, '数据修订', 256);
      else if (input.expected_revision !== undefined) return fail('invalid_parameters', '固定修订与步骤绑定不能并存');
      if (!Object.hasOwn(input, 'value')) return fail('invalid_parameters', '数据写入缺少完整替换值');
      if (new TextEncoder().encode(JSON.stringify(input.value)).byteLength > 256 * 1024)
        return fail('limit_exceeded', '数据值超过256KiB');
    }
    return;
  }
  if (tool.startsWith('ui_')) {
    if (input.root_id !== undefined) text(input.root_id, '挂载根标识');
    if (tool === 'ui_query') { keys(input, ['root_id', 'query']); query(input.query); }
    else if (tool === 'ui_assert') { keys(input, ['root_id', 'assertion']); assertion(input.assertion); }
    else if (tool === 'ui_action') {
      keys(input, ['root_id', 'action']);
      const request = object(input.action);
      if (targetBinding && (request.target !== undefined || ['wait', 'navigate', 'pick'].includes(String(request.type))))
        return fail('invalid_parameters', '节点绑定不能与固定节点、导航或等待并存');
      action(targetBinding ? { ...request, target: { id: 'pending', generation: 0, revision: 0 } } : request);
    } else {
      keys(input, ['root_id', 'view', 'snapshot_id', 'offset', 'limit']);
      if (input.view !== undefined && input.view !== 'overview') return fail('invalid_parameters', '不支持的界面树视图');
      if (input.snapshot_id !== undefined) text(input.snapshot_id, '快照标识');
      for (const key of ['offset', 'limit']) {
        const number = input[key];
        if (number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < (key === 'limit' ? 1 : 0) || number > (key === 'limit' ? 500 : 5000)))
          return fail('invalid_parameters', '快照分页参数超限');
      }
      if (typeof input.offset === 'number' && input.offset > 0 && input.snapshot_id === undefined && input.view !== 'overview')
        return fail('invalid_parameters', '快照续页需要原快照标识');
    }
    return;
  }
  keys(input, ['kind', 'id', 'version', 'input', 'confirmed', 'allow_unknown_side_effects', 'include_result']);
  text(input.id, '调用标识');
  if (!Object.hasOwn(input, 'input') || (input.kind !== 'service' && input.kind !== 'command'))
    return fail('invalid_parameters', '浏览器试调用需要种类和JSON输入');
  if (input.kind === 'service') text(input.version, '服务版本');
  else if (input.version !== undefined) return fail('invalid_parameters', '浏览器命令不接受版本');
  if (input.include_result !== undefined && typeof input.include_result !== 'boolean')
    return fail('invalid_parameters', '结果选项必须是布尔值');
}

// 在第一项动作之前检查整份计划，防止后半段格式错误留下已执行的前半段。
export function parsePlan(value: JsonValue): AutomationPlan {
  const input = object(json(value));
  keys(input, ['steps', 'confirmed', 'stop_on_failure']);
  if (typeof input.confirmed !== 'boolean' ||
    (input.stop_on_failure !== undefined && typeof input.stop_on_failure !== 'boolean'))
    return fail('invalid_parameters', '自动调试需要布尔确认和合法停止策略');
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 32)
    return fail('invalid_parameters', '自动调试需要1到32个步骤');
  const prior = new Map<string, string>();
  const steps: AutomationStep[] = [];
  for (const candidate of input.steps) {
    const step = object(candidate);
    keys(step, ['id', 'tool', 'parameters', 'bind']);
    const id = text(step.id, '步骤标识', 128);
    const tool = text(step.tool, '步骤工具', 32);
    if (prior.has(id) || !tools.has(tool)) return fail('invalid_parameters', '步骤标识重复或工具不支持自动调试');
    if (mutationTools.has(tool) && input.confirmed !== true)
      return fail('confirmation_required', '含变更的调试计划必须明确确认');
    const parameters = json(object(step.parameters));
    const binding = step.bind === undefined ? {} : object(step.bind);
    keys(binding, ['target_from_step', 'revision_from_step']);
    if (step.bind !== undefined && !Object.keys(binding).length) return fail('invalid_parameters', '步骤绑定不能为空');
    const target = binding.target_from_step === undefined ? undefined : text(binding.target_from_step, '节点来源步骤', 128);
    const revision = binding.revision_from_step === undefined ? undefined : text(binding.revision_from_step, '修订来源步骤', 128);
    if (target !== undefined && (tool !== 'ui_action' || prior.get(target) !== 'ui_query'))
      return fail('invalid_parameters', '节点绑定只能引用前面的界面查询，供界面动作使用');
    if (revision !== undefined && (tool !== 'data_write' || prior.get(revision) !== 'data_read'))
      return fail('invalid_parameters', '修订绑定只能引用前面的数据读取，供数据写入使用');
    if (tool === 'data_write' && object(parameters).confirmed !== true)
      return fail('confirmation_required', '每个数据写入步骤仍需明确确认');
    if (tool === 'invoke' && (object(parameters).confirmed !== true || object(parameters).allow_unknown_side_effects !== true))
      return fail('confirmation_required', '试调用步骤仍需确认本次调用和未知副作用');
    if (tool === 'ui_action') {
      const action = object(object(parameters).action);
      if (action.type === 'pick') return fail('invalid_parameters', '自动调试不支持等待人工拾取');
      if (action.type !== 'wait' && action.type !== 'highlight' && action.confirmed !== true)
        return fail('confirmation_required', '界面变更步骤仍需明确确认');
    }
    preflight(tool, parameters, target !== undefined, revision !== undefined);
    steps.push({ id, tool, parameters, bind: {
      ...(target === undefined ? {} : { target_from_step: target }),
      ...(revision === undefined ? {} : { revision_from_step: revision }),
    } });
    prior.set(id, tool);
  }
  return { steps, stopOnFailure: input.stop_on_failure !== false };
}
