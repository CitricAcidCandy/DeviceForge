import { ApiError } from '../../../services/api/index.ts';
import { downloadPublishedArtifact } from '../../../shared/jobs/index.ts';
import type { createJobRunner } from '../../../shared/jobs/index.ts';
import type { ArtifactReader, JobTicket, PublishedResult } from '../../../shared/jobs/index.ts';
import { decodeBuild, decodeDecoded, decodeScan, decodeSplits } from '../utils/extended-results.ts';
import { normalizeBuild, normalizeScan, normalizeSplits } from '../utils/extended-rules.ts';
import { normalizeArtifact } from '../utils/rules.ts';
import type { PackageArtifactInput } from '../types/index.ts';
import type { PackageBuildInput, PackageBuildResult, PackageDecodedResult, PackageScanInput, PackageSplitsInput, PackageSplitsResult } from '../types/extended.ts';

type Action = 'build_apks' | 'decode' | 'scan_sdks' | 'extract_splits';
const operation = (action: Action) => `plugin.android-packages.${action}`;
function checkTicket(action: Action, ticket: JobTicket): void {
  if (ticket.operation !== operation(action)) throw new ApiError('protocol', 'invalid_package_ticket', '恢复任务与包分析操作不匹配');
}
export function createExtendedPackageAnalysis(jobs: ReturnType<typeof createJobRunner>, lifetime: AbortSignal, artifacts?: ArtifactReader) {
  function download<T>(result: PublishedResult<T>, filename: string, signal: AbortSignal) {
    if (!artifacts) throw new ApiError('protocol', 'artifact_reader_unavailable', '包分析模块未装配产物下载能力');
    return downloadPublishedArtifact(artifacts, result, filename, AbortSignal.any([signal, lifetime]));
  }
  return {
    buildApks(input: PackageBuildInput, signal: AbortSignal) {
      const normalized = normalizeBuild(input);
      return jobs.execute(operation('build_apks'), normalized, signal, (value, logId) => decodeBuild(value, logId, normalized));
    },
    decode(input: PackageArtifactInput, signal: AbortSignal) {
      const normalized = normalizeArtifact(input);
      return jobs.execute(operation('decode'), normalized, signal, decodeDecoded);
    },
    scanSdks(input: PackageScanInput, signal: AbortSignal) {
      const normalized = normalizeScan(input);
      return jobs.execute(operation('scan_sdks'), normalized, signal, (value, logId) => decodeScan(value, logId, normalized));
    },
    extractSplits(input: PackageSplitsInput, signal: AbortSignal) {
      const normalized = normalizeSplits(input);
      return jobs.execute(operation('extract_splits'), normalized, signal, (value, logId) => decodeSplits(value, logId, normalized));
    },
    resumeBuildApks(ticket: JobTicket, input: PackageBuildInput, signal: AbortSignal) {
      checkTicket('build_apks', ticket); const normalized = normalizeBuild(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeBuild(value, logId, normalized));
    },
    resumeDecode(ticket: JobTicket, input: PackageArtifactInput, signal: AbortSignal) {
      checkTicket('decode', ticket); normalizeArtifact(input);
      return jobs.resume(ticket, signal, decodeDecoded);
    },
    resumeScanSdks(ticket: JobTicket, input: PackageScanInput, signal: AbortSignal) {
      checkTicket('scan_sdks', ticket); const normalized = normalizeScan(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeScan(value, logId, normalized));
    },
    resumeExtractSplits(ticket: JobTicket, input: PackageSplitsInput, signal: AbortSignal) {
      checkTicket('extract_splits', ticket); const normalized = normalizeSplits(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeSplits(value, logId, normalized));
    },
    downloadBuilt: (result: PackageBuildResult, signal: AbortSignal) => download(result, 'built.apks', signal),
    downloadDecoded: (result: PackageDecodedResult, signal: AbortSignal) => download(result, 'decoded.zip', signal),
    downloadSplits: (result: PackageSplitsResult, signal: AbortSignal) => download(result, 'selected-apks.zip', signal),
  };
}
