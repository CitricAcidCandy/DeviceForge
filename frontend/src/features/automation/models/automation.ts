import { ApiError } from '../../../services/api/index.ts';
import { createJobRunner, requireJson } from '../../../shared/jobs/index.ts';
import type { ArtifactReader, JobGateway, JobTicket } from '../../../shared/jobs/index.ts';
import { createDesktopAutomation } from './desktop.ts';
import { frozenAutomationCopy, requireRepeat, requireSequence } from '../utils/rules.ts';
import { decodeAutomationResult } from '../utils/results.ts';
import type { AutomationOptions, AutomationSequence, RepeatedClick } from '../types/index.ts';
import { automationOperation, createAutomationCatalog, isAutomationOperation } from './catalog.ts';
export type * from '../types/index.ts';
export type * from '../types/desktop.ts';
export { convertLegacyMouse } from '../utils/legacy-mouse.ts';
export type { LegacyMouseOptions } from '../utils/legacy-mouse.ts';
export function createAutomation(
  gateway: JobGateway,
  options: AutomationOptions = {},
  artifacts?: ArtifactReader,
) {
  const jobs = createJobRunner(gateway, options);
  const lifetime = new AbortController();
  const current = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  const catalog = createAutomationCatalog(options.operations);
  const desktop = createDesktopAutomation(gateway, artifacts, options, catalog.requireOperation);
  function ticket(action: 'sequence.run' | 'click.repeat', value: JobTicket): void {
    if (value.operation !== automationOperation(action))
      throw new ApiError('protocol', 'invalid_automation_ticket', '恢复任务与自动化操作不匹配');
  }
  return {
    ...desktop,
    refreshOperations: catalog.refresh,
    snapshot: catalog.snapshot,
    runSequence(input: AutomationSequence, signal: AbortSignal) {
      requireSequence(input);
      const expected = frozenAutomationCopy(input);
      return jobs.execute(
        catalog.requireOperation('sequence.run'),
        requireJson(expected),
        current(signal),
        (value, logId) =>
          decodeAutomationResult(value, logId, expected.device_id, expected.steps.length),
      );
    },
    repeatClick(input: RepeatedClick, signal: AbortSignal) {
      requireRepeat(input);
      const expected = frozenAutomationCopy(input);
      return jobs.execute(
        catalog.requireOperation('click.repeat'),
        requireJson(expected),
        current(signal),
        (value, logId) => decodeAutomationResult(value, logId, expected.device_id, expected.count),
      );
    },
    resumeSequence(value: JobTicket, input: AutomationSequence, signal: AbortSignal) {
      ticket('sequence.run', value);
      requireSequence(input);
      const expected = frozenAutomationCopy(input);
      return jobs.resume(value, current(signal), (raw, logId) =>
        decodeAutomationResult(raw, logId, expected.device_id, expected.steps.length),
      );
    },
    resumeRepeat(value: JobTicket, input: RepeatedClick, signal: AbortSignal) {
      ticket('click.repeat', value);
      requireRepeat(input);
      const expected = frozenAutomationCopy(input);
      return jobs.resume(value, current(signal), (raw, logId) =>
        decodeAutomationResult(raw, logId, expected.device_id, expected.count),
      );
    },
    queryJob(value: JobTicket, signal: AbortSignal) {
      if (!isAutomationOperation(value.operation))
        throw new ApiError('protocol', 'invalid_automation_ticket', '任务不属于自动化模块');
      return jobs.query(value, current(signal));
    },
    cancel(value: JobTicket, signal: AbortSignal) {
      if (!isAutomationOperation(value.operation))
        throw new ApiError('protocol', 'invalid_automation_ticket', '任务不属于自动化模块');
      return jobs.cancel(value, current(signal));
    },
    dispose() {
      lifetime.abort();
      catalog.dispose();
      jobs.dispose();
      desktop.dispose();
    },
  };
}
