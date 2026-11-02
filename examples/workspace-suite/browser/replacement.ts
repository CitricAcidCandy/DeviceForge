import { HostError } from '@deviceforge/plugin-sdk';
import { isJsonValue } from '@deviceforge/plugin-sdk/json';
import type { HostContext, JsonValue, UiAccess, WorkspaceCatalog, WorkspaceInstance } from '@deviceforge/plugin-sdk';
import { record } from './domain/message.ts';
import { activationGeneration } from './domain/generation.ts';

type Provider = { pluginId: string; viewId: string };
export type SelectionObservation = {
  ownerPluginId: string;
  generation: number;
  provider: Provider | null;
  providerGeneration: number | null;
  target: JsonValue;
};
export type ViewReplacementResult = {
  status: 'selected' | 'restored';
  mount: 'not_observed';
  replacementId: string;
  instanceId: string;
  workspaceId: string;
  original: SelectionObservation;
  current: SelectionObservation;
};

function inputError(message: string): never {
  throw new HostError('protocol', 'example_replacement_input', message);
}
function conflict(message: string): never {
  throw new HostError('http', 'example_replacement_conflict', message, null, 409);
}
function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}
function generation(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function provider(value: unknown): Provider | null {
  if (value === null) return null;
  if (!fields(value, ['pluginId', 'viewId']) || !text(value.pluginId) || !text(value.viewId))
    return inputError('提供者必须显式包含 pluginId 和 viewId');
  return { pluginId: value.pluginId, viewId: value.viewId };
}
function selection(value: unknown): SelectionObservation {
  if (!fields(value, ['ownerPluginId', 'generation', 'provider', 'providerGeneration', 'target']) ||
      !text(value.ownerPluginId) || !generation(value.generation) || !isJsonValue(value.target))
    return inputError('expected 必须包含实例所有者、代次、原提供者、提供者代次及完整 target');
  const reference = provider(value.provider);
  if (reference ? !generation(value.providerGeneration) : value.providerGeneration !== null)
    return inputError('已选提供者需要明确代次，未选择时 providerGeneration 必须为 null');
  return {
    ownerPluginId: value.ownerPluginId, generation: value.generation, provider: reference,
    providerGeneration: typeof value.providerGeneration === 'number' ? value.providerGeneration : null,
    target: structuredClone(value.target),
  };
}
function observe(instance: WorkspaceInstance): SelectionObservation {
  return {
    ownerPluginId: instance.pluginId, generation: instance.generation,
    provider: instance.provider ? { ...instance.provider } : null,
    providerGeneration: instance.providerGeneration, target: structuredClone(instance.target),
  };
}
function canonical(value: JsonValue): string {
  return JSON.stringify(value, (_key, child: unknown) => record(child)
    ? Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]])) : child);
}
function same(first: JsonValue, second: JsonValue): boolean {
  return canonical(first) === canonical(second);
}
function available(catalog: WorkspaceCatalog, reference: Provider | null, expectedGeneration: number | null): void {
  if (!reference) return;
  const found = catalog.views.filter((view) =>
    view.pluginId === reference.pluginId && view.id === reference.viewId);
  if (found.length !== 1 || found[0]?.generation !== expectedGeneration)
    conflict('明确提供者不存在、身份不唯一或代次已变化，请重新读取公开目录');
}
function instance(ui: UiAccess, owner: string, workspaceId: string, instanceId: string): WorkspaceInstance {
  const snapshot = ui.snapshot(), found = snapshot.instances.filter((entry) => entry.instanceId === instanceId);
  const current = found[0];
  if (found.length !== 1 || !current || current.workspaceId !== workspaceId || current.pluginId !== owner ||
      current.state === 'missing')
    conflict('明确实例不存在、不属于此套件、工作区不符或当前不可选择；不会猜测第一项');
  if (snapshot.catalog.workspaces.filter((entry) => entry.id === workspaceId).length !== 1)
    conflict('明确工作区不存在或身份不唯一');
  return current;
}

/** 仅示范公开选择与显式恢复；不把同步selectProvider当作挂载准备/提交事务。 */
export function createViewReplacement(context: HostContext, pluginId: string) {
  const receipts = new Map<string, ViewReplacementResult>(), latest = new Map<string, string>();
  const epoch = activationGeneration();
  let sequence = 0;
  const clear = () => {
    receipts.clear(); latest.clear(); context.signal.removeEventListener('abort', clear);
  };
  context.signal.addEventListener('abort', clear, { once: true });
  context.onDispose(clear);
  const access = (signal: AbortSignal): UiAccess => {
    context.signal.throwIfAborted(); signal.throwIfAborted();
    if (!context.ui) throw new HostError('protocol', 'example_ui_missing', '宿主未提供公开工作区选择能力');
    return context.ui;
  };
  const checked = (ui: UiAccess, workspaceId: string, instanceId: string, expected: SelectionObservation) => {
    const current = instance(ui, pluginId, workspaceId, instanceId);
    if (expected.ownerPluginId !== pluginId || !same(observe(current), expected))
      conflict('实例、目标或原选择已变化，请保留当前选择并重新读取');
    available(ui.catalog(), expected.provider, expected.providerGeneration);
    return current;
  };
  const select = (ui: UiAccess, workspaceId: string, instanceId: string, expected: SelectionObservation,
    reference: Provider | null, providerGeneration: number | null, signal: AbortSignal): SelectionObservation => {
    checked(ui, workspaceId, instanceId, expected);
    available(ui.catalog(), reference, providerGeneration);
    context.signal.throwIfAborted(); signal.throwIfAborted();
    // 只有一次公开选择；异常或回读冲突不自动重试，也不反向覆盖另一选择。
    const returned = ui.selectProvider(instanceId, reference);
    context.signal.throwIfAborted(); signal.throwIfAborted();
    const current = instance(ui, pluginId, workspaceId, instanceId), observed = observe(current);
    if (returned.instanceId !== instanceId || returned.workspaceId !== workspaceId ||
        current.generation < expected.generation || returned.generation !== current.generation ||
        !same(observe(returned), observed) || !same(observed.provider, reference) ||
        observed.providerGeneration !== providerGeneration || !same(observed.target, expected.target))
      conflict('选择回读未确认，请查询实例；不会自动恢复或重放，挂载结果尚未观测');
    return observed;
  };
  return {
    replace(input: JsonValue, signal: AbortSignal): ViewReplacementResult {
      const ui = access(signal);
      if (!fields(input, ['instanceId', 'workspaceId', 'expected', 'provider']) ||
          !text(input.instanceId) || !text(input.workspaceId) ||
          !fields(input.provider, ['pluginId', 'viewId', 'generation']) ||
          !text(input.provider.pluginId) || !text(input.provider.viewId) || !generation(input.provider.generation))
        return inputError('替换必须显式提供 instanceId、workspaceId、expected 和带 generation 的 provider');
      const original = selection(input.expected), reference = {
        pluginId: input.provider.pluginId, viewId: input.provider.viewId,
      };
      const replacementId = `${pluginId}.replacement.${epoch}.${++sequence}`;
      const current = select(ui, input.workspaceId, input.instanceId, original, reference, input.provider.generation, signal);
      const receipt: ViewReplacementResult = {
        status: 'selected', mount: 'not_observed', replacementId,
        instanceId: input.instanceId, workspaceId: input.workspaceId, original, current,
      };
      const previous = latest.get(input.instanceId);
      if (previous) receipts.delete(previous);
      latest.set(input.instanceId, replacementId); receipts.set(replacementId, receipt);
      return structuredClone(receipt);
    },
    restore(input: JsonValue, signal: AbortSignal): ViewReplacementResult {
      const ui = access(signal);
      if (!fields(input, ['replacementId', 'instanceId', 'workspaceId', 'expected']) ||
          !text(input.replacementId) || !text(input.instanceId) || !text(input.workspaceId))
        return inputError('恢复必须显式提供 replacementId、instanceId、workspaceId 和 expected');
      const receipt = receipts.get(input.replacementId), expected = selection(input.expected);
      if (!receipt || receipt.instanceId !== input.instanceId || receipt.workspaceId !== input.workspaceId ||
          latest.get(input.instanceId) !== input.replacementId)
        conflict('此代恢复记录不存在、已使用或已被新替换取代');
      if (!same(expected, receipt.current)) conflict('恢复观测不属于原替换结果，不覆盖后来选择');
      const current = select(ui, input.workspaceId, input.instanceId, expected,
        receipt.original.provider, receipt.original.providerGeneration, signal);
      receipts.delete(input.replacementId); latest.delete(input.instanceId);
      return { ...structuredClone(receipt), status: 'restored', current };
    },
  };
}
