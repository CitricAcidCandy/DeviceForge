import { ApiError } from '../../shared/api/index.ts';
import { createJobRunner, requireJson } from '../../shared/jobs/index.ts';
import type { ArtifactReader, JobGateway, JobOptions, JobTicket } from '../../shared/jobs/index.ts';
import { createDesktopAutomation } from './desktop.ts';
import { requireRepeat, requireSequence } from './rules.ts';
import { decodeAutomationResult } from './results.ts';
import type { AutomationSequence, RepeatedClick } from './types.ts';

export type * from './types.ts';
export type * from './desktop-types.ts';
export { convertLegacyMouse } from './legacy-mouse.ts';
export type { LegacyMouseOptions } from './legacy-mouse.ts';
export function createAutomation(gateway: JobGateway, options: JobOptions = {}, artifacts?: ArtifactReader) {
  const jobs = createJobRunner(gateway, options);
  const desktop = createDesktopAutomation(gateway, artifacts, options);
  function ticket(action: 'sequence.run' | 'click.repeat', value: JobTicket): void {
    if (value.operation !== `plugin.automation.${action}`) throw new ApiError('protocol', 'invalid_automation_ticket', '恢复任务与自动化操作不匹配');
  }
  return {
    ...desktop,
    runSequence(input: AutomationSequence, signal: AbortSignal) {
      requireSequence(input); const deviceId = input.device_id; const count = input.steps.length;
      return jobs.execute('plugin.automation.sequence.run', requireJson(input), signal, (value, logId) => decodeAutomationResult(value, logId, deviceId, count));
    },
    repeatClick(input: RepeatedClick, signal: AbortSignal) {
      requireRepeat(input); const deviceId = input.device_id; const count = input.count;
      return jobs.execute('plugin.automation.click.repeat', requireJson(input), signal, (value, logId) => decodeAutomationResult(value, logId, deviceId, count));
    },
    resumeSequence(value: JobTicket, input: AutomationSequence, signal: AbortSignal) {
      ticket('sequence.run', value); requireSequence(input); const deviceId = input.device_id; const count = input.steps.length;
      return jobs.resume(value, signal, (raw, logId) => decodeAutomationResult(raw, logId, deviceId, count));
    },
    resumeRepeat(value: JobTicket, input: RepeatedClick, signal: AbortSignal) {
      ticket('click.repeat', value); requireRepeat(input); const deviceId = input.device_id; const count = input.count;
      return jobs.resume(value, signal, (raw, logId) => decodeAutomationResult(raw, logId, deviceId, count));
    },
    cancel(value: JobTicket, signal: AbortSignal) {
      if (!['plugin.automation.sequence.run', 'plugin.automation.click.repeat'].includes(value.operation)) return desktop.cancelDesktop(value, signal);
      return jobs.cancel(value, signal);
    },
    dispose() { jobs.dispose(); desktop.dispose(); },
  };
}
