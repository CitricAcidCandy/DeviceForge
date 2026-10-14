import { isRawMetricValues } from '../../../shared/api/metric-missing.ts';
import { isRecord } from '../../../shared/api/validation.ts';
import { onlyKeys } from '../../../shared/jobs/index.ts';
import { isDeviceObservation } from './observations.ts';
import { integer } from './rules.ts';
import type { ProfileMetrics } from './types.ts';

// 原始累积计数不是会话派生读数，不添加 sequence、CPU 百分比或 FPS。
export function isProfileMetrics(value: unknown, deviceId: string): value is ProfileMetrics {
  if (!isRecord(value) || !onlyKeys(value, ['captured_at', 'pid', 'process_start_ticks', 'process_ticks', 'system_ticks', 'logical_cpus', 'pss_kib', 'rss_kib', 'frame_window', 'device_observation', 'metric_missing'])
    || !integer(value.captured_at) || !integer(value.pid, 1, 4294967295) || !integer(value.process_start_ticks)
    || !integer(value.process_ticks) || !isRawMetricValues(value)
    || !isDeviceObservation(value.device_observation, deviceId, value.captured_at)) return false;
  const window = value.frame_window;
  return window === undefined || window === null || isRecord(window) && onlyKeys(window, ['frames', 'duration_ms', 'source'])
    && integer(window.duration_ms, 1, 60000) && integer(window.frames, 0, window.duration_ms)
    && typeof window.source === 'string' && window.source.length >= 1 && window.source.length <= 80 && /^[a-zA-Z0-9._-]+$/.test(window.source);
}
