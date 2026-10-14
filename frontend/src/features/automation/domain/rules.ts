import { ApiError } from '../../../shared/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';

export function frozenAutomationCopy<T>(value: T): T {
  const copied: T = structuredClone(value);
  function freeze(item: unknown): void {
    if (item !== null && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  }
  freeze(copied); return copied;
}
export function validAutomationUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export const automationDevice = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(value);
const coordinate = (value: unknown): value is number => naturalNumber(value) && value <= 65535;
function action(value: unknown): boolean {
  if (!jsonObject(value)) return false;
  if (value.kind === 'tap') return onlyKeys(value, ['kind', 'x', 'y']) && coordinate(value.x) && coordinate(value.y);
  if (value.kind === 'swipe') return onlyKeys(value, ['kind', 'x1', 'y1', 'x2', 'y2', 'duration_ms']) && [value.x1, value.y1, value.x2, value.y2].every(coordinate) && naturalNumber(value.duration_ms) && value.duration_ms >= 1 && value.duration_ms <= 10000;
  if (value.kind === 'key') return onlyKeys(value, ['kind', 'code']) && naturalNumber(value.code) && value.code <= 288;
  return value.kind === 'text' && onlyKeys(value, ['kind', 'text']) && typeof value.text === 'string' && value.text.length <= 1024 && /^[A-Za-z0-9 .,_@-]+$/.test(value.text);
}
export function requireSequence(value: unknown): void {
  if (!jsonObject(value) || !onlyKeys(value, ['device_id', 'steps']) || !automationDevice(value.device_id) || !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 10000) throw invalid();
  let previous = 0;
  for (const step of value.steps) {
    if (!jsonObject(step) || !onlyKeys(step, ['at_ms', 'action']) || !naturalNumber(step.at_ms) || step.at_ms < previous || step.at_ms > 3600000 || !action(step.action)) throw invalid();
    previous = step.at_ms;
  }
}
export function requireRepeat(value: unknown): void {
  if (!jsonObject(value) || !onlyKeys(value, ['device_id', 'x', 'y', 'count', 'interval_ms']) || !automationDevice(value.device_id) || !coordinate(value.x) || !coordinate(value.y)
    || !naturalNumber(value.count) || value.count < 1 || value.count > 10000 || !naturalNumber(value.interval_ms) || value.interval_ms < 10 || value.interval_ms > 60000
    || (value.count - 1) * value.interval_ms > 3600000) throw invalid();
}
function invalid(): ApiError { return new ApiError('protocol', 'invalid_automation_input', '自动化设备、动作、时间顺序或执行数量无效'); }
