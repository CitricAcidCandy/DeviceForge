import { ApiError } from '../../shared/api/index.ts';
import { createJobRunner, downloadPublishedArtifact, requireJson } from '../../shared/jobs/index.ts';
import type { ArtifactReader, JobGateway, JobOptions, JobTicket, PublishedResult } from '../../shared/jobs/index.ts';
import { requireDesktopClick, requireInputTrace } from './desktop-rules.ts';
import { decodeDesktopClick, decodeDesktopPosition, decodeDesktopRepeat, decodeInputTracePlayback, decodeInputTraceRecord } from './desktop-results.ts';
import type { DesktopClick, DesktopRepeat, InputTracePlayback, InputTraceRecord } from './desktop-types.ts';

export function createDesktopAutomation(gateway: JobGateway, artifacts: ArtifactReader | undefined, options: JobOptions = {}) {
  const jobs = createJobRunner(gateway, options); const lifetime = new AbortController();
  const current = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  const operations = ['windows.mouse.position', 'windows.mouse.click', 'windows.mouse.repeat', 'input_trace.record', 'input_trace.playback'];
  function ticket(action: string, value: JobTicket): void {
    if (!operations.includes(action) || value.operation !== `plugin.automation.${action}`) throw new ApiError('protocol', 'invalid_automation_ticket', '恢复任务与 Windows 自动化操作不匹配');
  }
  return {
    mousePosition: (signal: AbortSignal) => jobs.execute('plugin.automation.windows.mouse.position', {}, current(signal), decodeDesktopPosition),
    clickMouse(input: DesktopClick, signal: AbortSignal) {
      requireDesktopClick(input, false); const expected = { ...input, ...(input.position ? { position: { ...input.position } } : {}) };
      return jobs.execute('plugin.automation.windows.mouse.click', requireJson(input), current(signal), (value, logId) => decodeDesktopClick(value, logId, expected));
    },
    repeatMouse(input: DesktopRepeat, signal: AbortSignal) {
      requireDesktopClick(input, true); const expected = { ...input, repeat: { ...input.repeat } };
      return jobs.execute('plugin.automation.windows.mouse.repeat', requireJson(input), current(signal), (value, logId) => decodeDesktopRepeat(value, logId, expected));
    },
    recordInputTrace(input: InputTraceRecord, signal: AbortSignal) {
      requireInputTrace(input, false); const expected = { ...input };
      return jobs.execute('plugin.automation.input_trace.record', requireJson(input), current(signal), (value, logId) => decodeInputTraceRecord(value, logId, expected));
    },
    playbackInputTrace(input: InputTracePlayback, signal: AbortSignal) {
      requireInputTrace(input, true); const expected = { ...input };
      return jobs.execute('plugin.automation.input_trace.playback', requireJson(input), current(signal), (value, logId) => decodeInputTracePlayback(value, logId, expected));
    },
    resumeMousePosition(value: JobTicket, signal: AbortSignal) { ticket('windows.mouse.position', value); return jobs.resume(value, current(signal), decodeDesktopPosition); },
    resumeMouseClick(value: JobTicket, input: DesktopClick, signal: AbortSignal) {
      ticket('windows.mouse.click', value); requireDesktopClick(input, false); const expected = { ...input, ...(input.position ? { position: { ...input.position } } : {}) };
      return jobs.resume(value, current(signal), (raw, logId) => decodeDesktopClick(raw, logId, expected));
    },
    resumeMouseRepeat(value: JobTicket, input: DesktopRepeat, signal: AbortSignal) {
      ticket('windows.mouse.repeat', value); requireDesktopClick(input, true); const expected = { ...input, repeat: { ...input.repeat } };
      return jobs.resume(value, current(signal), (raw, logId) => decodeDesktopRepeat(raw, logId, expected));
    },
    resumeInputTraceRecord(value: JobTicket, input: InputTraceRecord, signal: AbortSignal) {
      ticket('input_trace.record', value); requireInputTrace(input, false); const expected = { ...input };
      return jobs.resume(value, current(signal), (raw, logId) => decodeInputTraceRecord(raw, logId, expected));
    },
    resumeInputTracePlayback(value: JobTicket, input: InputTracePlayback, signal: AbortSignal) {
      ticket('input_trace.playback', value); requireInputTrace(input, true); const expected = { ...input };
      return jobs.resume(value, current(signal), (raw, logId) => decodeInputTracePlayback(raw, logId, expected));
    },
    cancelDesktop(value: JobTicket, signal: AbortSignal) {
      if (!operations.some((action) => value.operation === `plugin.automation.${action}`)) throw new ApiError('protocol', 'invalid_automation_ticket', '任务不属于 Windows 自动化模块');
      return jobs.cancel(value, current(signal));
    },
    downloadTrace<T>(output: PublishedResult<T>, filename: 'recording.msgpack' | 'operation.json' | 'input-trace.log', signal: AbortSignal) {
      if (!artifacts) throw new ApiError('protocol', 'artifact_access_unavailable', '宿主未提供输入轨迹产物下载能力');
      return downloadPublishedArtifact(artifacts, output, filename, current(signal));
    },
    dispose() { lifetime.abort(); jobs.dispose(); },
  };
}
