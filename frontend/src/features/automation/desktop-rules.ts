import { ApiError } from '../../shared/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../shared/jobs/index.ts';
import { validAutomationUnicode } from './rules.ts';

export const int32 = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
const time = (value: unknown): value is number => naturalNumber(value) && value >= 100 && value <= 600000;
const event = (value: unknown): boolean => value === 0 || value === 1 || value === 2;
export function requireDesktopClick(value: unknown, repeat: boolean): void {
  if (!jsonObject(value) || !onlyKeys(value, ['button', 'click', 'position', ...(repeat ? ['interval_ms', 'repeat', 'stop_on_f9'] : [])])
    || !['left', 'right', 'middle'].some((button) => button === value.button) || value.click !== 'single' && value.click !== 'double'
    || value.position !== undefined && (!jsonObject(value.position) || !onlyKeys(value.position, ['x', 'y']) || !int32(value.position.x) || !int32(value.position.y))) throw invalid();
  if (!repeat) return;
  if (!naturalNumber(value.interval_ms) || value.interval_ms < 10 || value.interval_ms > 60000 || !jsonObject(value.repeat)
    || value.stop_on_f9 !== undefined && typeof value.stop_on_f9 !== 'boolean') throw invalid();
  const limit = value.repeat;
  if (limit.kind === 'count' && onlyKeys(limit, ['kind', 'count']) && naturalNumber(limit.count) && limit.count >= 1 && limit.count <= 10000 && (limit.count - 1) * value.interval_ms <= 600000) return;
  if (limit.kind === 'duration' && onlyKeys(limit, ['kind', 'duration_ms']) && time(limit.duration_ms)) return;
  if (limit.kind === 'manual' && onlyKeys(limit, ['kind', 'max_duration_ms']) && time(limit.max_duration_ms)) return;
  throw invalid();
}
export function requireInputTrace(value: unknown, playback: boolean): void {
  if (!jsonObject(value) || !onlyKeys(value, playback ? ['artifact_id', 'event_type'] : ['event_type', 'interval_ms', 'duration_ms']) || !event(value.event_type)) throw invalid();
  if (playback) {
    if (typeof value.artifact_id !== 'string' || !value.artifact_id || !validAutomationUnicode(value.artifact_id)
      || new TextEncoder().encode(value.artifact_id).length > 200 || /\p{Cc}/u.test(value.artifact_id)) throw invalid();
  } else if (!naturalNumber(value.interval_ms) || value.interval_ms < 2 || value.interval_ms > 1000 || !time(value.duration_ms)) throw invalid();
}
function invalid(): ApiError { return new ApiError('protocol', 'invalid_desktop_automation_input', 'Windows 鼠标或输入轨迹业务参数无效'); }
