import { ApiError } from '../../../services/api/index.ts';
import { jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';

export const aiProjectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
export const aiThreadId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function requireAiInput(value: unknown, single: boolean): void {
  if (
    !jsonObject(value) ||
    !onlyKeys(value, single ? ['project_id', 'prompt'] : ['project_id', 'prompt', 'thread_id']) ||
    !aiProjectId(value.project_id) ||
    typeof value.prompt !== 'string' ||
    !value.prompt.trim() ||
    new TextEncoder().encode(value.prompt).length > 131072 ||
    (!single && value.thread_id !== undefined && !aiThreadId(value.thread_id))
  )
    throw new ApiError('protocol', 'invalid_ai_input', 'AI 项目、提示词或线程身份无效');
}
export function requireAiSession(value: unknown): void {
  if (
    !jsonObject(value) ||
    !onlyKeys(value, ['project_id', 'thread_id']) ||
    !aiProjectId(value.project_id) ||
    !aiThreadId(value.thread_id)
  )
    throw new ApiError('protocol', 'invalid_ai_session', 'AI 会话项目或线程身份无效');
}
