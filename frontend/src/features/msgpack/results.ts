import { decodeArtifactEnvelope, decodeEmptyArtifactResult, invalidBusinessResult, jsonObject, naturalNumber, onlyKeys, requireArtifactNames } from '../../shared/jobs/index.ts';
import { isMsgpackJson, maximumArtifactSize } from './rules.ts';
import type { NormalizedMsgpackPage } from './rules.ts';
import type { MsgpackConversion, MsgpackConversionResult, MsgpackPage } from './types.ts';

const moduleName = 'MessagePack';
export function decodeConversion(value: unknown, logId: string | null, source: string, filename: MsgpackConversion['filename']): MsgpackConversionResult {
  const envelope = decodeArtifactEnvelope(value, moduleName, logId);
  requireArtifactNames(envelope, [filename], moduleName, logId);
  const result = envelope.result;
  const artifact = envelope.artifacts[0];
  if (!jsonObject(result) || !onlyKeys(result, ['format_version', 'source_artifact_id', 'filename', 'size'])
    || result.format_version !== 1 || result.source_artifact_id !== source || result.filename !== filename
    || !naturalNumber(result.size) || result.size > maximumArtifactSize || !artifact
    || artifact.size !== result.size || artifact.media_type !== (filename === 'converted.msgpack' ? 'application/msgpack' : 'application/json')) {
    throw invalidBusinessResult(moduleName, logId);
  }
  return { result: { format_version: 1, source_artifact_id: source, filename, size: result.size }, artifacts: envelope.artifacts };
}
export function decodePage(value: unknown, logId: string | null, input: NormalizedMsgpackPage): MsgpackPage {
  const result = decodeEmptyArtifactResult(value, moduleName, logId);
  if (!jsonObject(result) || !onlyKeys(result, ['format_version', 'source_artifact_id', 'total', 'matched', 'offset', 'records', 'next_offset'])
    || result.format_version !== 1 || result.source_artifact_id !== input.artifact_id || result.offset !== input.offset
    || !naturalNumber(result.total) || !naturalNumber(result.matched) || !naturalNumber(result.offset)
    || result.matched > result.total || result.offset > result.matched || !Array.isArray(result.records)
    || !isMsgpackJson(result.records) || result.records.length !== Math.min(input.limit, result.matched - result.offset)) {
    throw invalidBusinessResult(moduleName, logId);
  }
  const next = result.offset + result.records.length;
  if (result.next_offset !== (next < result.matched ? next : null)) throw invalidBusinessResult(moduleName, logId);
  return {
    format_version: 1, source_artifact_id: input.artifact_id, total: result.total, matched: result.matched,
    offset: result.offset, records: structuredClone(result.records), next_offset: next < result.matched ? next : null,
  };
}
