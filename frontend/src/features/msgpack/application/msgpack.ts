import { ApiError } from '../../../shared/api/index.ts';
import { createJobRunner, downloadPublishedArtifact } from '../../../shared/jobs/index.ts';
import type { ArtifactReader, JobGateway, JobOptions, JobTicket } from '../../../shared/jobs/index.ts';
import { decodeConversion, decodePage } from '../domain/results.ts';
import { normalizeById, normalizeConversion, normalizePage } from '../domain/rules.ts';
import type { MsgpackByIdInput, MsgpackConversionInput, MsgpackConversionResult, MsgpackPageInput } from '../domain/types.ts';

export type * from '../domain/types.ts';

type Action = 'encode' | 'decode' | 'query';
const operation = (action: Action) => `plugin.msgpack.${action}`;
function checkTicket(action: Action, ticket: JobTicket): void {
  if (ticket.operation !== operation(action)) throw new ApiError('protocol', 'invalid_msgpack_ticket', '恢复任务与 MessagePack 操作不匹配');
}
function checkModuleTicket(ticket: JobTicket): void {
  if (!['encode', 'decode', 'query'].some((action) => ticket.operation === `plugin.msgpack.${action}`)) {
    throw new ApiError('protocol', 'invalid_msgpack_ticket', '任务不属于 MessagePack 模块');
  }
}
export function createMsgpack(gateway: JobGateway, options: JobOptions = {}, artifacts?: ArtifactReader) {
  const jobs = createJobRunner(gateway, options);
  const lifetime = new AbortController();
  return {
    encode(input: MsgpackConversionInput, signal: AbortSignal) {
      const normalized = normalizeConversion(input);
      return jobs.execute(operation('encode'), normalized, signal, (value, logId) => decodeConversion(value, logId, normalized.artifact_id, 'converted.msgpack'));
    },
    decode(input: MsgpackConversionInput, signal: AbortSignal) {
      const normalized = normalizeConversion(input);
      return jobs.execute(operation('decode'), normalized, signal, (value, logId) => decodeConversion(value, logId, normalized.artifact_id, 'converted.json'));
    },
    page(input: MsgpackPageInput, signal: AbortSignal) {
      const normalized = normalizePage(input);
      return jobs.execute(operation('query'), normalized, signal, (value, logId) => decodePage(value, logId, normalized));
    },
    byId(input: MsgpackByIdInput, signal: AbortSignal) {
      const normalized = normalizeById(input);
      return jobs.execute(operation('query'), normalized, signal, (value, logId) => decodePage(value, logId, normalized));
    },
    resumeEncode(ticket: JobTicket, input: MsgpackConversionInput, signal: AbortSignal) {
      checkTicket('encode', ticket); const normalized = normalizeConversion(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeConversion(value, logId, normalized.artifact_id, 'converted.msgpack'));
    },
    resumeDecode(ticket: JobTicket, input: MsgpackConversionInput, signal: AbortSignal) {
      checkTicket('decode', ticket); const normalized = normalizeConversion(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeConversion(value, logId, normalized.artifact_id, 'converted.json'));
    },
    resumePage(ticket: JobTicket, input: MsgpackPageInput, signal: AbortSignal) {
      checkTicket('query', ticket); const normalized = normalizePage(input);
      return jobs.resume(ticket, signal, (value, logId) => decodePage(value, logId, normalized));
    },
    resumeById(ticket: JobTicket, input: MsgpackByIdInput, signal: AbortSignal) {
      checkTicket('query', ticket); const normalized = normalizeById(input);
      return jobs.resume(ticket, signal, (value, logId) => decodePage(value, logId, normalized));
    },
    queryJob(ticket: JobTicket, signal: AbortSignal) { checkModuleTicket(ticket); return jobs.query(ticket, signal); },
    cancel(ticket: JobTicket, signal: AbortSignal) { checkModuleTicket(ticket); return jobs.cancel(ticket, signal); },
    download(result: MsgpackConversionResult, signal: AbortSignal) {
      if (!artifacts) throw new ApiError('protocol', 'artifact_reader_unavailable', 'MessagePack 模块未装配产物下载能力');
      const current = AbortSignal.any([signal, lifetime.signal]);
      return downloadPublishedArtifact(artifacts, result, result.result.filename, current);
    },
    dispose() { lifetime.abort(); jobs.dispose(); },
  };
}
