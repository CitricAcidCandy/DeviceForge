import { ApiError } from '../../shared/api/index.ts';
import { abortable } from '../../shared/api/abort.ts';
import { createJobRunner, downloadPublishedArtifact, requireJson } from '../../shared/jobs/index.ts';
import type { ArtifactReader, JobGateway, JobOptions, JobTicket, PublishedResult } from '../../shared/jobs/index.ts';
import { isMp4Header, requireMirroringRequest } from './rules.ts';
import { decodeMirroringRecording, decodeMirroringStatus } from './results.ts';
import type { MirroringRecording, MirroringRequest } from './types.ts';

export type * from './types.ts';
export function createMirroring(gateway: JobGateway, artifacts: ArtifactReader, options: JobOptions = {}) {
  const jobs = createJobRunner(gateway, options); const lifetime = new AbortController();
  const current = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  function ticket(action: 'runtime.status' | 'record', value: JobTicket): void {
    if (value.operation !== `plugin.mirroring.${action}`) throw new ApiError('protocol', 'invalid_mirroring_ticket', '恢复任务与投屏操作不匹配');
  }
  return {
    runtimeStatus: (signal: AbortSignal) => jobs.execute('plugin.mirroring.runtime.status', {}, current(signal), decodeMirroringStatus),
    record(input: MirroringRequest, signal: AbortSignal) {
      requireMirroringRequest(input); const expected = { ...input };
      return jobs.execute('plugin.mirroring.record', requireJson(input), current(signal), (value, logId) => decodeMirroringRecording(value, logId, expected));
    },
    resumeStatus(value: JobTicket, signal: AbortSignal) { ticket('runtime.status', value); return jobs.resume(value, current(signal), decodeMirroringStatus); },
    resumeRecord(value: JobTicket, input: MirroringRequest, signal: AbortSignal) {
      ticket('record', value); requireMirroringRequest(input); const expected = { ...input };
      return jobs.resume(value, current(signal), (raw, logId) => decodeMirroringRecording(raw, logId, expected));
    },
    cancel(value: JobTicket, signal: AbortSignal) {
      if (!['plugin.mirroring.runtime.status', 'plugin.mirroring.record'].includes(value.operation)) throw new ApiError('protocol', 'invalid_mirroring_ticket', '任务不属于投屏模块');
      return jobs.cancel(value, current(signal));
    },
    async downloadRecording(output: PublishedResult<MirroringRecording>, signal: AbortSignal) {
      const active = current(signal); const result = await downloadPublishedArtifact(artifacts, output, 'screen.mp4', active);
      const header = await abortable(result.data.slice(0, 12).arrayBuffer(), active);
      if (!isMp4Header(header)) throw new ApiError('protocol', 'invalid_mirroring_video', '下载产物没有有效 MP4 文件头', null, result.logId);
      return result;
    },
    dispose() { lifetime.abort(); jobs.dispose(); },
  };
}
