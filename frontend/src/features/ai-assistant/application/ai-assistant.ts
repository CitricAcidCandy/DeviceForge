import { ApiError } from '../../../shared/api/index.ts';
import { createJobRunner, requireJson } from '../../../shared/jobs/index.ts';
import type { JobGateway, JobOptions, JobTicket } from '../../../shared/jobs/index.ts';
import { requireAiInput, requireAiSession } from '../domain/rules.ts';
import { decodeAiSession, decodeAiStatus, decodeAiTurn } from '../domain/results.ts';
import type { AiSessionInput, AiSingleInput, AiTurnInput } from '../domain/types.ts';

export type * from '../domain/types.ts';
export { createAiTaskObserver } from './task-observer.ts';
export type { AiTaskGateway, AiTaskObservation, AiTaskSnapshot } from './task-observer.ts';
export { createHttpAiTaskGateway } from '../infrastructure/task-observer-http.ts';
export { convertLegacyAiSingleRequest } from '../domain/legacy.ts';
export type { AiLegacySingleOptions } from '../domain/legacy.ts';
export function createAiAssistant(gateway: JobGateway, options: JobOptions = {}) {
  const jobs = createJobRunner(gateway, options);
  function ticket(action: 'runtime.status' | 'cli.single' | 'cli.turn' | 'session.get' | 'session.close', value: JobTicket): void {
    if (value.operation !== `plugin.ai-assistant.${action}`) throw new ApiError('protocol', 'invalid_ai_ticket', '恢复任务与 AI 助手操作不匹配');
  }
  function checkModuleTicket(value: JobTicket): void {
    if (!['runtime.status', 'cli.single', 'cli.turn', 'session.get', 'session.close'].some((action) => value.operation === `plugin.ai-assistant.${action}`)) throw new ApiError('protocol', 'invalid_ai_ticket', '任务不属于 AI 助手模块');
  }
  return {
    runtimeStatus: (signal: AbortSignal) => jobs.execute('plugin.ai-assistant.runtime.status', {}, signal, decodeAiStatus),
    single(input: AiSingleInput, signal: AbortSignal) {
      requireAiInput(input, true); const projectId = input.project_id;
      return jobs.execute('plugin.ai-assistant.cli.single', requireJson(input), signal, (value, logId) => decodeAiTurn(value, logId, projectId));
    },
    turn(input: AiTurnInput, signal: AbortSignal) {
      requireAiInput(input, false); const projectId = input.project_id; const threadId = input.thread_id?.toLowerCase();
      const request = { project_id: projectId, prompt: input.prompt, ...(threadId !== undefined ? { thread_id: threadId } : {}) };
      return jobs.execute('plugin.ai-assistant.cli.turn', request, signal, (value, logId) => decodeAiTurn(value, logId, projectId, threadId));
    },
    getSession(input: AiSessionInput, signal: AbortSignal) {
      requireAiSession(input); const expected = { project_id: input.project_id, thread_id: input.thread_id.toLowerCase() };
      return jobs.execute('plugin.ai-assistant.session.get', expected, signal, (value, logId) => decodeAiSession(value, logId, expected, false));
    },
    closeSession(input: AiSessionInput, signal: AbortSignal) {
      requireAiSession(input); const expected = { project_id: input.project_id, thread_id: input.thread_id.toLowerCase() };
      return jobs.execute('plugin.ai-assistant.session.close', expected, signal, (value, logId) => decodeAiSession(value, logId, expected, true));
    },
    resumeStatus(value: JobTicket, signal: AbortSignal) { ticket('runtime.status', value); return jobs.resume(value, signal, decodeAiStatus); },
    resumeSingle(value: JobTicket, input: AiSingleInput, signal: AbortSignal) {
      ticket('cli.single', value); requireAiInput(input, true); const projectId = input.project_id;
      return jobs.resume(value, signal, (raw, logId) => decodeAiTurn(raw, logId, projectId));
    },
    resumeTurn(value: JobTicket, input: AiTurnInput, signal: AbortSignal) {
      ticket('cli.turn', value); requireAiInput(input, false); const projectId = input.project_id; const threadId = input.thread_id?.toLowerCase();
      return jobs.resume(value, signal, (raw, logId) => decodeAiTurn(raw, logId, projectId, threadId));
    },
    resumeGetSession(value: JobTicket, input: AiSessionInput, signal: AbortSignal) {
      ticket('session.get', value); requireAiSession(input); const expected = { project_id: input.project_id, thread_id: input.thread_id.toLowerCase() };
      return jobs.resume(value, signal, (raw, logId) => decodeAiSession(raw, logId, expected, false));
    },
    resumeCloseSession(value: JobTicket, input: AiSessionInput, signal: AbortSignal) {
      ticket('session.close', value); requireAiSession(input); const expected = { project_id: input.project_id, thread_id: input.thread_id.toLowerCase() };
      return jobs.resume(value, signal, (raw, logId) => decodeAiSession(raw, logId, expected, true));
    },
    query(value: JobTicket, signal: AbortSignal) { checkModuleTicket(value); return jobs.query(value, signal); },
    cancel(value: JobTicket, signal: AbortSignal) { checkModuleTicket(value); return jobs.cancel(value, signal); },
    dispose: jobs.dispose,
  };
}
