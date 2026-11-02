import { HostError } from '@deviceforge/plugin-sdk';
import type { JsonValue } from '@deviceforge/plugin-sdk';
import { normalizeContract } from '../../shared/service-contracts.ts';
import type { NormalizeOutput } from '../../shared/service-contracts.ts';

export type MessageValue = NormalizeOutput;
export interface MessageSnapshot { value: MessageValue; revision: string }
export const MESSAGE_SCHEMA: JsonValue = normalizeContract.inputSchema;
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function message(value: unknown): MessageValue {
  if (!record(value) || Object.keys(value).length !== 1 ||
      typeof value.message !== 'string' || [...value.message].length > 1000)
    throw new HostError('protocol', 'invalid_example_message', '输入必须仅含最多1000字符的 message 字符串');
  return { message: value.message };
}
export function emptyInput(value: unknown): void {
  if (!record(value) || Object.keys(value).length !== 0)
    throw new HostError('protocol', 'invalid_example_input', '此只读操作只接受空对象');
}

/** 一代提供者拥有一份内存数据；重载使用新的命名空间，不复活旧修订。 */
export function createMessageStore(epoch: string, signal: AbortSignal) {
  let value = { message: '' }, revision = 0;
  const active = () => {
    if (signal.aborted) throw new HostError('cancelled', 'example_message_revoked', '此代内存数据已撤销');
  };
  const read = (): MessageSnapshot => {
    active();
    return { value: { ...value }, revision: `${epoch}:${revision}` };
  };
  return {
    read,
    write(input: unknown): MessageSnapshot {
      active();
      if (!record(input) || Object.keys(input).length !== 2 || !('value' in input) ||
          typeof input.expectedRevision !== 'string')
        throw new HostError('protocol', 'invalid_example_write', '写入需要 value 和原 expectedRevision');
      const next = message(input.value);
      if (input.expectedRevision !== `${epoch}:${revision}`)
        throw new HostError('http', 'data_source_conflict', '数据已变化，请保留草稿并重新读取', null, 409);
      value = next;
      revision++;
      return read();
    },
  };
}
