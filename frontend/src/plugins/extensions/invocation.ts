import { HostError } from '../../plugin-sdk/index.ts';
import type { CommandContribution, HostResult, JsonValue, TaskSubmission } from '../../plugin-sdk/index.ts';
import type { ExtensionOwner } from './types.ts';
import { isJsonValue } from '../../plugin-sdk/json.ts';

export function ensureOwner(owner: ExtensionOwner): void {
  if (owner.context.signal.aborted) throw new HostError('cancelled', 'extension_revoked', '扩展运行代次已撤销');
}
export function isSubmission(value: unknown): value is TaskSubmission {
  return typeof value === 'object' && value !== null && 'operation' in value && 'input' in value
    && typeof value.operation === 'string' && !!value.operation.trim() && isJsonValue(value.input);
}
export async function invoke(
  owner: ExtensionOwner, call: CommandContribution['execute'], input: JsonValue, signal: AbortSignal,
  available: () => boolean,
): Promise<HostResult<JsonValue>> {
  ensureOwner(owner);
  const combined = AbortSignal.any([owner.context.signal, signal]);
  if (combined.aborted || !available()) throw new HostError('cancelled', 'extension_revoked', '扩展调用已撤销');
  const result: unknown = await call(input, owner.context, combined);
  ensureOwner(owner);
  if (combined.aborted || !available()) throw new HostError('cancelled', 'stale_extension', '晚到扩展结果已撤销');
  if (typeof result !== 'object' || result === null || !('data' in result) || !('logId' in result)
    || !isJsonValue(result.data) || !(result.logId === null || typeof result.logId === 'string')) {
    throw new HostError('protocol', 'invalid_extension_result', '扩展返回值无效');
  }
  return { data: result.data, logId: result.logId };
}
