import { ApiError } from '../../../services/api/index.ts';
import type { createJobRunner, JobTicket } from '../../../shared/jobs/index.ts';
import {
  decodeRuntimeFeaturePreparation,
  decodeRuntimeFeatureStatus,
} from '../utils/feature-results.ts';
import { requireRuntimeFeatureKey } from '../utils/feature-rules.ts';

type RuntimeFeatureAction = 'status' | 'prepare';
const operation = (action: RuntimeFeatureAction) => `plugin.tool-supply.runtime_feature.${action}`;

export function isRuntimeFeatureOperation(value: string): boolean {
  return value === operation('status') || value === operation('prepare');
}
function checkTicket(action: RuntimeFeatureAction, ticket: JobTicket): void {
  if (ticket.operation !== operation(action))
    throw new ApiError('protocol', 'invalid_tool_ticket', '恢复任务与工具运行时功能操作不匹配');
}
export function createRuntimeFeature(jobs: ReturnType<typeof createJobRunner>) {
  return {
    runtimeFeatureStatus(featureKey: string, signal: AbortSignal) {
      requireRuntimeFeatureKey(featureKey);
      return jobs.execute(
        operation('status'),
        { feature_key: featureKey },
        signal,
        (value, logId) => decodeRuntimeFeatureStatus(value, logId, featureKey),
      );
    },
    prepareRuntimeFeature(featureKey: string, signal: AbortSignal) {
      requireRuntimeFeatureKey(featureKey);
      return jobs.execute(
        operation('prepare'),
        { feature_key: featureKey },
        signal,
        (value, logId) => decodeRuntimeFeaturePreparation(value, logId, featureKey),
      );
    },
    resumeRuntimeFeatureStatus(ticket: JobTicket, featureKey: string, signal: AbortSignal) {
      checkTicket('status', ticket);
      requireRuntimeFeatureKey(featureKey);
      return jobs.resume(ticket, signal, (value, logId) =>
        decodeRuntimeFeatureStatus(value, logId, featureKey),
      );
    },
    resumePrepareRuntimeFeature(ticket: JobTicket, featureKey: string, signal: AbortSignal) {
      checkTicket('prepare', ticket);
      requireRuntimeFeatureKey(featureKey);
      return jobs.resume(ticket, signal, (value, logId) =>
        decodeRuntimeFeaturePreparation(value, logId, featureKey),
      );
    },
  };
}
