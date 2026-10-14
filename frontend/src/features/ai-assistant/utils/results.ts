import { isRecord } from '../../../shared/api/validation.ts';
import { decimalU64, decodeEmptyArtifactResult, invalidBusinessResult, isJsonData, jsonObject } from '../../../shared/jobs/index.ts';
import type { AiRuntimeStatus, AiSessionInput, AiSessionResult, AiTurnResult } from '../types/index.ts';
import { aiProjectId, aiThreadId } from './rules.ts';

export function decodeAiStatus(raw: unknown, logId: string | null): AiRuntimeStatus {
  const value = decodeEmptyArtifactResult(raw, 'AI 助手', logId);
  if (!isRecord(value) || value.configured !== true || value.provider !== 'codex_cli' || !Array.isArray(value.projects) || !value.projects.every(aiProjectId)) throw invalidBusinessResult('AI 助手', logId);
  return { configured: true, provider: 'codex_cli', projects: value.projects.filter(aiProjectId) };
}
export function decodeAiTurn(raw: unknown, logId: string | null, projectId: string, threadId?: string): AiTurnResult {
  const value = decodeEmptyArtifactResult(raw, 'AI 助手', logId);
  if (!isRecord(value) || value.project_id !== projectId || typeof value.text !== 'string' || !value.text
    || !aiThreadId(value.thread_id) || threadId !== undefined && value.thread_id.toLowerCase() !== threadId.toLowerCase()
    || !Array.isArray(value.events) || value.events.length === 0 || value.events.length > 10000 || !value.events.every(isJsonData)) throw invalidBusinessResult('AI 助手', logId);
  const events = value.events.filter(isJsonData);
  const actualThreadId = value.thread_id.toLowerCase();
  if (!events.some((event) => jsonObject(event) && event.type === 'turn.completed')
    || events.some((event) => jsonObject(event) && (event.type === 'turn.failed' || event.type === 'error'))) throw invalidBusinessResult('AI 助手', logId);
  if (events.some((event) => jsonObject(event) && event.type === 'thread.started'
    && (!aiThreadId(event.thread_id) || event.thread_id.toLowerCase() !== actualThreadId))) throw invalidBusinessResult('AI 助手', logId);
  return { text: value.text, thread_id: actualThreadId, project_id: projectId, events };
}
export function decodeAiSession(raw: unknown, logId: string | null, input: AiSessionInput, close: boolean): AiSessionResult {
  const value = decodeEmptyArtifactResult(raw, 'AI 助手', logId);
  if (!isRecord(value) || value.project_id !== input.project_id || !aiThreadId(value.thread_id) || value.thread_id.toLowerCase() !== input.thread_id.toLowerCase() || !decimalU64(value.turns)
    || typeof value.closed !== 'boolean' || typeof value.uncertain !== 'boolean' || close && value.closed !== true) throw invalidBusinessResult('AI 助手', logId);
  return { project_id: input.project_id, thread_id: value.thread_id.toLowerCase(), turns: value.turns, closed: value.closed, uncertain: value.uncertain };
}
