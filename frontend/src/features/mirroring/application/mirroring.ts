import { ApiError } from '../../../shared/api/index.ts';
import { abortable } from '../../../shared/api/abort.ts';
import { createJobRunner, downloadPublishedArtifact, requireJson } from '../../../shared/jobs/index.ts';
import type { ArtifactReader, JobGateway, JobTicket, PublishedResult } from '../../../shared/jobs/index.ts';
import { frozenMirroringCopy, isMp4Header, requireMirroringRequest } from '../domain/rules.ts';
import { decodeMirroringDownload, decodeMirroringRecording, decodeMirroringStatus } from '../domain/results.ts';
import type { MirroringAction, MirroringOptions, MirroringRecording, MirroringRequest } from '../domain/types.ts';
import { createMirroringCatalog, isMirroringOperation, mirroringOperation } from './catalog.ts';
export type * from '../domain/types.ts';
export function createMirroring(gateway: JobGateway, artifacts: ArtifactReader, options: MirroringOptions = {}) {
  const jobs = createJobRunner(gateway, options); const lifetime = new AbortController();
  const catalog = createMirroringCatalog(options.operations);
  const current = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  function ticket(action: MirroringAction, value: JobTicket): void {
    if (value.operation !== mirroringOperation(action)) throw new ApiError('protocol', 'invalid_mirroring_ticket', '恢复任务与投屏操作不匹配');
  }
  return {
    refreshOperations: catalog.refresh,
    snapshot: catalog.snapshot,
    runtimeStatus: (signal: AbortSignal) => jobs.execute(catalog.requireOperation('runtime.status'), {}, current(signal), decodeMirroringStatus),
    record(input: MirroringRequest, signal: AbortSignal) {
      requireMirroringRequest(input); const expected = frozenMirroringCopy(input);
      return jobs.execute(catalog.requireOperation('record'), requireJson(expected), current(signal), (value, logId) => decodeMirroringRecording(value, logId, expected));
    },
    resumeStatus(value: JobTicket, signal: AbortSignal) { ticket('runtime.status', value); return jobs.resume(value, current(signal), decodeMirroringStatus); },
    resumeRecord(value: JobTicket, input: MirroringRequest, signal: AbortSignal) {
      ticket('record', value); requireMirroringRequest(input); const expected = frozenMirroringCopy(input);
      return jobs.resume(value, current(signal), (raw, logId) => decodeMirroringRecording(raw, logId, expected));
    },
    queryJob(value: JobTicket, signal: AbortSignal) {
      if (!isMirroringOperation(value.operation)) throw new ApiError('protocol', 'invalid_mirroring_ticket', '任务不属于投屏模块');
      return jobs.query(value, current(signal));
    },
    cancel(value: JobTicket, signal: AbortSignal) {
      if (!isMirroringOperation(value.operation)) throw new ApiError('protocol', 'invalid_mirroring_ticket', '任务不属于投屏模块');
      return jobs.cancel(value, current(signal));
    },
    async downloadRecording(output: PublishedResult<MirroringRecording>, signal: AbortSignal) {
      const active = current(signal); const copied = decodeMirroringDownload(output, null);
      const result = await downloadPublishedArtifact(artifacts, copied, 'screen.mp4', active);
      try {
        const header = await abortable(result.data.slice(0, 12).arrayBuffer(), active);
        if (active.aborted) throw new ApiError('cancelled', 'cancelled', '视频下载等待已取消', null, result.logId);
        if (!isMp4Header(header)) throw new ApiError('protocol', 'invalid_mirroring_video', '下载产物没有有效MP4文件头', null, result.logId);
        return result;
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'cancelled' && error.logId === null) throw new ApiError(error.kind, error.code, error.message, error.status, result.logId, error.retryAfter);
        throw error;
      }
    },
    dispose() { lifetime.abort(); catalog.dispose(); jobs.dispose(); },
  };
}
