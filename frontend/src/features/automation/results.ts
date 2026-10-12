import { isRecord } from '../../shared/api/validation.ts';
import { decodeEmptyArtifactResult, invalidBusinessResult } from '../../shared/jobs/index.ts';
import type { AutomationResult } from './types.ts';

export function decodeAutomationResult(raw: unknown, logId: string | null, deviceId: string, dispatched: number): AutomationResult {
  const value = decodeEmptyArtifactResult(raw, '自动化', logId);
  if (!isRecord(value) || value.device_id !== deviceId || value.dispatched !== dispatched || value.completed !== true || value.effect_confirmed !== false) throw invalidBusinessResult('自动化', logId);
  return { device_id: deviceId, dispatched, completed: true, effect_confirmed: false };
}
