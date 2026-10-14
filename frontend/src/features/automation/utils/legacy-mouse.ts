import { ApiError } from '../../../services/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';
import { int32, requireDesktopClick } from './desktop-rules.ts';
import type { DesktopPosition, DesktopRepeat, DesktopRepeatLimit } from '../types/desktop.ts';

export interface LegacyMouseOptions {
  readonly manualMaxDurationMs?: number;
}

function invalid(): ApiError {
  return new ApiError('protocol', 'invalid_legacy_mouse', '旧自动点击配置无效或超过当前限额');
}

function position(input: Record<string, unknown>): DesktopPosition | undefined {
  const nested = input.clickPos !== undefined;
  const flat = input.clickPosX !== undefined || input.clickPosY !== undefined;
  if (nested && flat) throw invalid();
  if (
    nested &&
    (!jsonObject(input.clickPos) ||
      !onlyKeys(input.clickPos, ['x', 'y']) ||
      !int32(input.clickPos.x) ||
      !int32(input.clickPos.y))
  )
    throw invalid();
  if (flat && (!int32(input.clickPosX) || !int32(input.clickPosY))) throw invalid();
  if (input.clickPosType === 0) return undefined;
  if (nested && jsonObject(input.clickPos) && int32(input.clickPos.x) && int32(input.clickPos.y)) {
    return { x: input.clickPos.x, y: input.clickPos.y };
  }
  if (flat && int32(input.clickPosX) && int32(input.clickPosY))
    return { x: input.clickPosX, y: input.clickPosY };
  throw invalid();
}

function milliseconds(seconds: number): number {
  const [coefficient = '', exponentText = '0'] = seconds.toString().split('e');
  const [whole = '', fraction = ''] = coefficient.split('.');
  const exponent = Number(exponentText) - fraction.length + 3;
  const digits = BigInt(whole + fraction);
  if (exponent >= 0) return Number(digits * 10n ** BigInt(exponent));
  const divisor = 10n ** BigInt(-exponent);
  if (digits % divisor !== 0n) throw invalid();
  return Number(digits / divisor);
}

function limit(input: Record<string, unknown>, options: LegacyMouseOptions): DesktopRepeatLimit {
  if (input.repeatedType === 0) {
    if (typeof options.manualMaxDurationMs !== 'number') throw invalid();
    return { kind: 'manual', max_duration_ms: options.manualMaxDurationMs };
  }
  if (options.manualMaxDurationMs !== undefined) throw invalid();
  if (input.repeatedType === 1 && typeof input.repeatedClickCount === 'number') {
    return { kind: 'count', count: input.repeatedClickCount };
  }
  if (input.repeatedType === 2 && typeof input.repeatedClickDuration === 'number') {
    return { kind: 'duration', duration_ms: milliseconds(input.repeatedClickDuration) };
  }
  throw invalid();
}

export function convertLegacyMouse(
  input: unknown,
  options: LegacyMouseOptions = {},
): DesktopRepeat {
  if (
    !jsonObject(input) ||
    !onlyKeys(input, [
      'mouseButtonType',
      'clickType',
      'clickPosType',
      'clickPos',
      'clickPosX',
      'clickPosY',
      'clickCountType',
      'timeInterval',
      'repeatedType',
      'repeatedClickCount',
      'repeatedClickDuration',
    ]) ||
    ![0, 1, 2].some((value) => value === input.mouseButtonType) ||
    (input.clickType !== 0 && input.clickType !== 1) ||
    (input.clickPosType !== 0 && input.clickPosType !== 1) ||
    ![0, 1, 2].some((value) => value === input.clickCountType) ||
    ![0, 1, 2].some((value) => value === input.repeatedType) ||
    (input.timeInterval !== undefined &&
      (!naturalNumber(input.timeInterval) ||
        (input.timeInterval !== 0 && input.timeInterval < 10) ||
        input.timeInterval > 60000)) ||
    (input.repeatedClickCount !== undefined &&
      (!naturalNumber(input.repeatedClickCount) || input.repeatedClickCount > 10000)) ||
    (input.repeatedClickDuration !== undefined &&
      (typeof input.repeatedClickDuration !== 'number' ||
        !Number.isFinite(input.repeatedClickDuration) ||
        input.repeatedClickDuration < 0 ||
        input.repeatedClickDuration > 600)) ||
    !jsonObject(options) ||
    !onlyKeys(options, ['manualMaxDurationMs'])
  )
    throw invalid();
  const intervalMs =
    input.clickCountType === 0 ? 100 : input.clickCountType === 1 ? 10 : input.timeInterval;
  if (typeof intervalMs !== 'number') throw invalid();
  const selectedPosition = position(input);
  const converted: DesktopRepeat = {
    button: input.mouseButtonType === 0 ? 'left' : input.mouseButtonType === 1 ? 'middle' : 'right',
    click: input.clickType === 0 ? 'single' : 'double',
    interval_ms: intervalMs,
    repeat: limit(input, options),
    stop_on_f9: true,
    ...(selectedPosition === undefined ? {} : { position: selectedPosition }),
  };
  try {
    requireDesktopClick(converted, true);
  } catch {
    throw invalid();
  }
  return converted;
}
