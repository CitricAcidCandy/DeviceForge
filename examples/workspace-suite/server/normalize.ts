import type { NormalizeOutput } from '../shared/service-contracts.ts';

/** 纯文本规则：不调用设备、文件、网络或外部进程。 */
export function normalize(input: unknown): NormalizeOutput {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 1 || !('message' in input) ||
      typeof input.message !== 'string' || [...input.message].length > 1000)
    throw new Error('输入必须仅含最多1000字符的 message 字符串');
  return { message: input.message.normalize('NFC').trim().replace(/\s+/gu, ' ') };
}
