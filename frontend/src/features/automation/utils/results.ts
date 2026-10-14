import { decodeEmptyArtifactResult, invalidBusinessResult, jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';
import type { AutomationResult } from '../types/index.ts';

export function decodeAutomationResult(raw: unknown, logId: string | null, deviceId: string, dispatched: number): AutomationResult {
  const value = decodeEmptyArtifactResult(raw, '自动化', logId);
  if (!jsonObject(value) || !onlyKeys(value, ['device_id', 'dispatched', 'completed', 'effect_confirmed'])
    || value.device_id !== deviceId || value.dispatched !== dispatched || value.completed !== true || value.effect_confirmed !== false) throw invalidBusinessResult('自动化', logId);
  return Object.freeze({ device_id: deviceId, dispatched, completed: true, effect_confirmed: false });
}
