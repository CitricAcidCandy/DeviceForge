import { ApiError } from '../../api.ts';
import { createJobRunner, requireJson } from '@deviceforge/business-kit/jobs';
import type { JobGateway, JobOptions, JobTicket } from '@deviceforge/business-kit/jobs';
import { requireAiInput, requireAiSession } from '../utils/rules.ts';
import { decodeAiSession, decodeAiStatus, decodeAiTurn } from '../utils/results.ts';
import type { AiSessionInput, AiSingleInput, AiTurnInput } from '../types/index.ts';

export type * from '../types/index.ts';
export { convertLegacyAiSingleRequest } from '../utils/legacy.ts';
export type { AiLegacySingleOptions } from '../utils/legacy.ts';
export function createAiAssistant(gateway: JobGateway, options: JobOptions & { readonly targetSignal?: () => AbortSignal } = {}) {
  const jobs = createJobRunner(gateway, options);
  const current = (signal: AbortSignal) => AbortSignal.any([
    signal, ...(options.targetSignal ? [options.targetSignal()] : []),
  ]);
  function ticket(
    action: 'runtime.status' | 'cli.single' | 'cli.turn' | 'session.get' | 'session.close',
    value: JobTicket,
  ): void {
    if (value.operation !== `plugin.ai-assistant.${action}`)
      throw new ApiError('protocol', 'invalid_ai_ticket', '恢复任务与 AI 助手操作不匹配');
  }
  function checkModuleTicket(value: JobTicket): void {
    if (
      !['runtime.status', 'cli.single', 'cli.turn', 'session.get', 'session.close'].some(
        (action) => value.operation === `plugin.ai-assistant.${action}`,
      )
    )
      throw new ApiError('protocol', 'invalid_ai_ticket', '任务不属于 AI 助手模块');
  }
  return {
    runtimeStatus: (signal: AbortSignal) =>
      jobs.execute('plugin.ai-assistant.runtime.status', {}, current(signal), decodeAiStatus),
    single(input: AiSingleInput, signal: AbortSignal) {
      requireAiInput(input, true);
      const projectId = input.project_id;
      return jobs.execute(
        'plugin.ai-assistant.cli.single',
        requireJson(input),
        current(signal),
        (value, logId) => decodeAiTurn(value, logId, projectId),
      );
    },
    turn(input: AiTurnInput, signal: AbortSignal) {
      requireAiInput(input, false);
      const projectId = input.project_id;
      const threadId = input.thread_id?.toLowerCase();
      const request = {
        project_id: projectId,
        prompt: input.prompt,
        ...(threadId !== undefined ? { thread_id: threadId } : {}),
      };
      return jobs.execute('plugin.ai-assistant.cli.turn', request, current(signal), (value, logId) =>
        decodeAiTurn(value, logId, projectId, threadId),
      );
    },
    getSession(input: AiSessionInput, signal: AbortSignal) {
      requireAiSession(input);
      const expected = { project_id: input.project_id, thread_id: input.thread_id.toLowerCase() };
      return jobs.execute('plugin.ai-assistant.session.get', expected, current(signal), (value, logId) =>
        decodeAiSession(value, logId, expected, false),
      );
    },
    closeSession(input: AiSessionInput, signal: AbortSignal) {
      requireAiSession(input);
      const expected = { project_id: input.project_id, thread_id: input.thread_id.toLowerCase() };
      return jobs.execute('plugin.ai-assistant.session.close', expected, current(signal), (value, logId) =>
        decodeAiSession(value, logId, expected, true),
      );
    },
    resumeStatus(value: JobTicket, signal: AbortSignal) {
      ticket('runtime.status', value);
      return jobs.resume(value, current(signal), decodeAiStatus);
    },
    resumeSingle(value: JobTicket, input: AiSingleInput, signal: AbortSignal) {
      ticket('cli.single', value);
      requireAiInput(input, true);
      const projectId = input.project_id;
      return jobs.resume(value, current(signal), (raw, logId) => decodeAiTurn(raw, logId, projectId));
    },
    resumeTurn(value: JobTicket, input: AiTurnInput, signal: AbortSignal) {
      ticket('cli.turn', value);
      requireAiInput(input, false);
      const projectId = input.project_id;
      const threadId = input.thread_id?.toLowerCase();
      return jobs.resume(value, current(signal), (raw, logId) =>
        decodeAiTurn(raw, logId, projectId, threadId),
      );
    },
    resumeGetSession(value: JobTicket, input: AiSessionInput, signal: AbortSignal) {
      ticket('session.get', value);
      requireAiSession(input);
      const expected = { project_id: input.project_id, thread_id: input.thread_id.toLowerCase() };
      return jobs.resume(value, current(signal), (raw, logId) =>
        decodeAiSession(raw, logId, expected, false),
      );
    },
    resumeCloseSession(value: JobTicket, input: AiSessionInput, signal: AbortSignal) {
      ticket('session.close', value);
      requireAiSession(input);
      const expected = { project_id: input.project_id, thread_id: input.thread_id.toLowerCase() };
      return jobs.resume(value, current(signal), (raw, logId) =>
        decodeAiSession(raw, logId, expected, true),
      );
    },
    query(value: JobTicket, signal: AbortSignal) {
      checkModuleTicket(value);
      return jobs.query(value, current(signal));
    },
    cancel(value: JobTicket, signal: AbortSignal) {
      checkModuleTicket(value);
      return jobs.cancel(value, current(signal));
    },
    dispose: jobs.dispose,
  };
}
