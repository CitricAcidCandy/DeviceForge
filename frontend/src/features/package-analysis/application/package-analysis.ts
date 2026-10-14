import { ApiError } from '../../../shared/api/index.ts';
import { createJobRunner, downloadPublishedArtifact } from '../../../shared/jobs/index.ts';
import type { ArtifactReader, JobGateway, JobOptions, JobTicket } from '../../../shared/jobs/index.ts';
import { decodeExtract, decodeManifest, decodeSignature } from '../domain/results.ts';
import { normalizeArtifact, normalizeExtract, normalizeManifest } from '../domain/rules.ts';
import type { PackageArtifactInput, PackageExtractInput, PackageExtractResult, PackageManifestInput } from '../domain/types.ts';
import { createExtendedPackageAnalysis } from './extended.ts';

export type * from '../domain/types.ts';
export type * from '../domain/extended-types.ts';
export { prepareApksInstallInput } from '../domain/apks-options.ts';
type Action = 'manifest' | 'signature' | 'extract_apk';
const operation = (action: Action) => `plugin.android-packages.${action}`;
function checkTicket(action: Action, ticket: JobTicket): void {
  if (ticket.operation !== operation(action)) throw new ApiError('protocol', 'invalid_package_ticket', '恢复任务与包分析操作不匹配');
}
function checkModuleTicket(ticket: JobTicket): void {
  if (!['manifest', 'signature', 'extract_apk', 'build_apks', 'decode', 'scan_sdks', 'extract_splits'].some((action) => ticket.operation === `plugin.android-packages.${action}`)) {
    throw new ApiError('protocol', 'invalid_package_ticket', '任务不属于包分析模块');
  }
}
export function createPackageAnalysis(gateway: JobGateway, options: JobOptions = {}, artifacts?: ArtifactReader) {
  const jobs = createJobRunner(gateway, options);
  const lifetime = new AbortController();
  return {
    ...createExtendedPackageAnalysis(jobs, lifetime.signal, artifacts),
    manifest(input: PackageManifestInput, signal: AbortSignal) {
      const normalized = normalizeManifest(input);
      return jobs.execute(operation('manifest'), normalized, signal, (value, logId) => decodeManifest(value, logId, normalized));
    },
    signature(input: PackageArtifactInput, signal: AbortSignal) {
      const normalized = normalizeArtifact(input);
      return jobs.execute(operation('signature'), normalized, signal, (value, logId) => decodeSignature(value, logId, normalized));
    },
    extractApk(input: PackageExtractInput, signal: AbortSignal) {
      const normalized = normalizeExtract(input);
      return jobs.execute(operation('extract_apk'), normalized, signal, (value, logId) => decodeExtract(value, logId, normalized));
    },
    resumeManifest(ticket: JobTicket, input: PackageManifestInput, signal: AbortSignal) {
      checkTicket('manifest', ticket); const normalized = normalizeManifest(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeManifest(value, logId, normalized));
    },
    resumeSignature(ticket: JobTicket, input: PackageArtifactInput, signal: AbortSignal) {
      checkTicket('signature', ticket); const normalized = normalizeArtifact(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeSignature(value, logId, normalized));
    },
    resumeExtractApk(ticket: JobTicket, input: PackageExtractInput, signal: AbortSignal) {
      checkTicket('extract_apk', ticket); const normalized = normalizeExtract(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeExtract(value, logId, normalized));
    },
    queryJob(ticket: JobTicket, signal: AbortSignal) { checkModuleTicket(ticket); return jobs.query(ticket, signal); },
    cancel(ticket: JobTicket, signal: AbortSignal) { checkModuleTicket(ticket); return jobs.cancel(ticket, signal); },
    download(result: PackageExtractResult, signal: AbortSignal) {
      if (!artifacts) throw new ApiError('protocol', 'artifact_reader_unavailable', '包分析模块未装配产物下载能力');
      return downloadPublishedArtifact(artifacts, result, 'extracted.apk', AbortSignal.any([signal, lifetime.signal]));
    },
    dispose() { lifetime.abort(); jobs.dispose(); },
  };
}
