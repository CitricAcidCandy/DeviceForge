import { ApiError } from '../../../shared/api/index.ts';
import { createJobRunner, jsonObject, nonemptyText, onlyKeys, requireJson } from '../../../shared/jobs/index.ts';
import type { JobGateway, JobTicket } from '../../../shared/jobs/index.ts';
import { aiSdkOperation, createAiSdkCatalog, isAiSdkOperation } from './catalog.ts';
import { normalizeAiSdkAssistant, normalizeAiSdkThread, normalizeAiSdkTurn } from '../utils/rules.ts';
import { decodeAiSdkAssistant, decodeAiSdkStatus, decodeAiSdkThread, decodeAiSdkTurn } from '../utils/results.ts';
import type { AiSdkAction, AiSdkAssistantInput, AiSdkOptions, AiSdkSingleInput, AiSdkThreadInput, AiSdkTurnInput } from '../types/index.ts';
export type * from '../types/index.ts';
function ticket(value: unknown, action?: AiSdkAction): JobTicket {
  if (!jsonObject(value) || !onlyKeys(value, ['id', 'operation', 'submitLogId']) || !nonemptyText(value.id)
    || typeof value.operation !== 'string' || !isAiSdkOperation(value.operation) || action !== undefined && value.operation !== aiSdkOperation(action)
    || value.submitLogId !== null && typeof value.submitLogId !== 'string') throw new ApiError('protocol', 'invalid_ai_sdk_ticket', 'SDK任务票据身份或操作不匹配');
  return Object.freeze({ id: value.id, operation: value.operation, submitLogId: value.submitLogId });
}
export function createAiSdk(gateway: JobGateway, options: AiSdkOptions = {}) {
  const jobs = createJobRunner(gateway, options); const catalog = createAiSdkCatalog(options.operations); const lifetime = new AbortController();
  const current = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  return {
    refreshOperations: catalog.refresh,
    snapshot: catalog.snapshot,
    runtimeStatus: (signal: AbortSignal) => jobs.execute(catalog.requireOperation('runtime.status'), {}, current(signal), decodeAiSdkStatus),
    single(input: AiSdkSingleInput, signal: AbortSignal) {
      const expected = normalizeAiSdkTurn(input, false);
      return jobs.execute(catalog.requireOperation('sdk.single'), requireJson(expected), current(signal), (raw, logId) => decodeAiSdkTurn(raw, logId, expected));
    },
    turn(input: AiSdkTurnInput, signal: AbortSignal) {
      const expected = normalizeAiSdkTurn(input, true);
      return jobs.execute(catalog.requireOperation('sdk.turn'), requireJson(expected), current(signal), (raw, logId) => decodeAiSdkTurn(raw, logId, expected));
    },
    getThread(input: AiSdkThreadInput, signal: AbortSignal) {
      const expected = normalizeAiSdkThread(input);
      return jobs.execute(catalog.requireOperation('session.get'), requireJson(expected), current(signal), (raw, logId) => decodeAiSdkThread(raw, logId, expected, false));
    },
    closeThread(input: AiSdkThreadInput, signal: AbortSignal) {
      const expected = normalizeAiSdkThread(input);
      return jobs.execute(catalog.requireOperation('session.close'), requireJson(expected), current(signal), (raw, logId) => decodeAiSdkThread(raw, logId, expected, true));
    },
    runAssistant(input: AiSdkAssistantInput, signal: AbortSignal) {
      const expected = normalizeAiSdkAssistant(input);
      return jobs.execute(catalog.requireOperation('assistant.run'), requireJson(expected), current(signal), (raw, logId) => decodeAiSdkAssistant(raw, logId, expected));
    },
    resumeStatus(value: JobTicket, signal: AbortSignal) { return jobs.resume(ticket(value, 'runtime.status'), current(signal), decodeAiSdkStatus); },
    resumeSingle(value: JobTicket, input: AiSdkSingleInput, signal: AbortSignal) {
      const job = ticket(value, 'sdk.single'); const expected = normalizeAiSdkTurn(input, false);
      return jobs.resume(job, current(signal), (raw, logId) => decodeAiSdkTurn(raw, logId, expected));
    },
    resumeTurn(value: JobTicket, input: AiSdkTurnInput, signal: AbortSignal) {
      const job = ticket(value, 'sdk.turn'); const expected = normalizeAiSdkTurn(input, true);
      return jobs.resume(job, current(signal), (raw, logId) => decodeAiSdkTurn(raw, logId, expected));
    },
    resumeGetThread(value: JobTicket, input: AiSdkThreadInput, signal: AbortSignal) {
      const job = ticket(value, 'session.get'); const expected = normalizeAiSdkThread(input);
      return jobs.resume(job, current(signal), (raw, logId) => decodeAiSdkThread(raw, logId, expected, false));
    },
    resumeCloseThread(value: JobTicket, input: AiSdkThreadInput, signal: AbortSignal) {
      const job = ticket(value, 'session.close'); const expected = normalizeAiSdkThread(input);
      return jobs.resume(job, current(signal), (raw, logId) => decodeAiSdkThread(raw, logId, expected, true));
    },
    resumeAssistant(value: JobTicket, input: AiSdkAssistantInput, signal: AbortSignal) {
      const job = ticket(value, 'assistant.run'); const expected = normalizeAiSdkAssistant(input);
      return jobs.resume(job, current(signal), (raw, logId) => decodeAiSdkAssistant(raw, logId, expected));
    },
    queryJob: (value: JobTicket, signal: AbortSignal) => jobs.query(ticket(value), current(signal)),
    cancel: (value: JobTicket, signal: AbortSignal) => jobs.cancel(ticket(value), current(signal)),
    dispose() { lifetime.abort(); catalog.dispose(); jobs.dispose(); },
  };
}
