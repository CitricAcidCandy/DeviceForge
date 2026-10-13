import { ApiError } from '../../shared/api/index.ts';
import { jsonObject, onlyKeys } from '../../shared/jobs/index.ts';
import type { AiSdkAssistantInput, AiSdkThreadInput, AiSdkTurnInput } from './types.ts';

export function frozenAiSdkCopy<T>(value: T): T {
  const copied: T = structuredClone(value);
  function freeze(item: unknown): void {
    if (item !== null && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  }
  freeze(copied); return copied;
}
export function aiSdkCharacterCount(value: string): number | null {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
    } else if (code >= 0xdc00 && code <= 0xdfff) return null;
    count++;
  }
  return count;
}
export const validAiSdkProject = (value: unknown): value is string => typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9_-]+$/.test(value);
export const aiSdkNonempty = (value: string): boolean => /[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(value);
export function validAiSdkPrompt(value: unknown): value is string {
  if (typeof value !== 'string' || !aiSdkNonempty(value)) return false;
  const count = aiSdkCharacterCount(value); return count !== null && count <= 131072;
}
export function normalizeAiSdkThreadId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) throw invalid();
  return value.toLowerCase();
}
export const validAiSdkCanonicalThread = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function normalizeAiSdkTurn(value: unknown, allowThread: boolean): AiSdkTurnInput {
  if (!jsonObject(value) || !onlyKeys(value, allowThread ? ['project_id', 'prompt', 'thread_id'] : ['project_id', 'prompt'])
    || !validAiSdkProject(value.project_id) || !validAiSdkPrompt(value.prompt)) throw invalid();
  const thread_id = Object.hasOwn(value, 'thread_id') ? normalizeAiSdkThreadId(value.thread_id) : undefined;
  return Object.freeze({ project_id: value.project_id, prompt: value.prompt, ...(thread_id === undefined ? {} : { thread_id }) });
}
export function normalizeAiSdkThread(value: unknown): AiSdkThreadInput {
  if (!jsonObject(value) || !onlyKeys(value, ['project_id', 'thread_id']) || !validAiSdkProject(value.project_id)) throw invalid();
  return Object.freeze({ project_id: value.project_id, thread_id: normalizeAiSdkThreadId(value.thread_id) });
}
export function normalizeAiSdkAssistant(value: unknown): AiSdkAssistantInput {
  if (!jsonObject(value) || !onlyKeys(value, ['project_id', 'user_prompt', 'stream_output']) || !validAiSdkProject(value.project_id)
    || Object.hasOwn(value, 'user_prompt') && !validAiSdkPrompt(value.user_prompt)
    || Object.hasOwn(value, 'stream_output') && typeof value.stream_output !== 'boolean') throw invalid();
  const user_prompt = typeof value.user_prompt === 'string' ? value.user_prompt : undefined;
  const stream_output = typeof value.stream_output === 'boolean' ? value.stream_output : undefined;
  return Object.freeze({ project_id: value.project_id, ...(user_prompt === undefined ? {} : { user_prompt }), ...(stream_output === undefined ? {} : { stream_output }) });
}
function invalid(): ApiError { return new ApiError('protocol', 'invalid_ai_sdk_input', 'SDK项目、提示词、线程或严格字段无效'); }
