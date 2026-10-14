import { HostError } from '../../plugin-sdk/index.ts';
import { isReadingMetricValues } from '../../shared/api/metric-missing.ts';
import { isRecord } from '../../shared/api/validation.ts';
import { isReadingDeviceObservation } from './device-observation.ts';
import type { PerformanceAction, PerformanceCapabilities, PerformancePage, PerformanceSession, PerformanceSessions, PerformanceStart } from './types.ts';

export const performanceOperation = (action: PerformanceAction) => `android.performance.${action}`;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const numberOrMissing = (value: unknown): boolean => value === undefined || value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));

export function isPerformanceStart(value: unknown): value is PerformanceStart {
  return isRecord(value) && keys(value, ['target', 'interval_ms', 'duration_secs']) && isRecord(value.target)
    && keys(value.target, ['device_id', 'package']) && typeof value.target.device_id === 'string'
    && value.target.device_id.length > 0 && value.target.device_id.length <= 200 && /^[a-zA-Z0-9._:\[\]][a-zA-Z0-9._:\[\]-]*$/.test(value.target.device_id)
    && typeof value.target.package === 'string' && value.target.package.length <= 200
    && /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(value.target.package)
    && integer(value.interval_ms, 1000, 60000) && integer(value.duration_secs, 1, 3600);
}

// 只检查真实返回的来源，不造临时 DTO，也不借当前目录补齐历史。
function validSource(value: unknown, deviceId: string): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || !keys(value, ['plugin_id', 'generation', 'operation', 'device'])
    || !text(value.plugin_id) || !text(value.generation) || !text(value.operation)
    || !value.operation.startsWith(`plugin.${value.plugin_id}.`)) return false;
  const device = value.device;
  return device === undefined || device === null || isRecord(device) && keys(device, ['provider_id', 'generation', 'local_id']) && text(device.provider_id)
    && text(device.generation) && text(device.local_id)
    && device.provider_id === value.plugin_id && device.generation === value.generation && device.local_id === deviceId;
}
export function isPerformanceSession(value: unknown): value is PerformanceSession {
  return isRecord(value) && uuid(value.id) && isPerformanceStart(value.request)
    && typeof value.state === 'string' && ['running', 'paused', 'stopped', 'completed', 'failed', 'interrupted'].includes(value.state)
    && integer(value.revision) && integer(value.samples, 0, 3600)
    && integer(value.started_at) && integer(value.updated_at) && value.updated_at >= value.started_at
    && (value.error === undefined || value.error === null || typeof value.error === 'string') && validSource(value.source, value.request.target.device_id);
}
function validReading(value: unknown, deviceId: string): boolean {
  if (!isRecord(value) || !integer(value.sequence, 1, 3600) || !integer(value.captured_at)
    || !integer(value.pid, 1, 4294967295) || !isReadingMetricValues(value)
    || !numberOrMissing(value.cpu_share_percent) || !numberOrMissing(value.cpu_core_percent) || !numberOrMissing(value.fps)) return false;
  if (value.cpu_share_percent !== undefined && value.cpu_share_percent !== null
    && typeof value.cpu_share_percent === 'number' && value.cpu_share_percent > 100) return false;
  if (typeof value.fps === 'number' && value.fps > 1000) return false;
  if (!isReadingDeviceObservation(value.device_observation, value.battery_net_power_mw, deviceId, value.captured_at)) return false;
  const window = value.frame_window;
  return window === undefined || window === null || isRecord(window) && integer(window.duration_ms, 1, 60000)
    && integer(window.frames, 0, window.duration_ms) && text(window.source) && window.source.length <= 80 && /^[a-zA-Z0-9._-]+$/.test(window.source);
}
export function isPerformancePage(value: unknown): value is PerformancePage {
  if (!isRecord(value) || !isPerformanceSession(value.session) || !Array.isArray(value.readings)
    || value.readings.length > 100 || !integer(value.next_after)) return false;
  let previous = 0;
  for (const reading of value.readings) {
    if (!validReading(reading, value.session.request.target.device_id) || !isRecord(reading) || !integer(reading.sequence)
      || reading.sequence <= previous || reading.sequence > value.session.samples) return false;
    previous = reading.sequence;
  }
  return previous === 0 || previous === value.next_after;
}
export function isPerformanceSessions(value: unknown): value is PerformanceSessions {
  if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > 100 || !value.sessions.every(isPerformanceSession)
    || !(value.next_after_id === undefined || value.next_after_id === null || uuid(value.next_after_id))) return false;
  const sessions = value.sessions.filter(isPerformanceSession);
  let previous = '';
  for (const session of sessions) {
    if (previous && session.id.toLowerCase() <= previous.toLowerCase()) return false;
    previous = session.id;
  }
  return sessions.length === 0 ? value.next_after_id == null : value.next_after_id === previous;
}
export function decodePerformanceCapabilities(value: unknown, logId: string | null): PerformanceCapabilities {
  if (!isRecord(value) || !Array.isArray(value.metrics) || !value.metrics.every(text)
    || typeof value.fps !== 'boolean' || !(value.device_observation === undefined || typeof value.device_observation === 'boolean') || !text(value.source) || value.scope !== 'main_process'
    || value.max_samples !== 3600 || value.sample_timeout_ms !== 10000) throw invalidResult(logId);
  const metrics: unknown[] = value.metrics;
  const names = metrics.filter(text);
  const deviceObservation = value.device_observation === true;
  const expected = ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib', ...(value.fps ? ['fps'] : []), ...(deviceObservation ? ['device_observation', 'battery_net_power_mw'] : [])];
  if (names.length !== expected.length || !expected.every((metric) => names.includes(metric))) throw invalidResult(logId);
  return { metrics: names, fps: value.fps, deviceObservation, sourceLabel: value.source, scope: 'main_process', maxSamples: value.max_samples, sampleTimeoutMs: value.sample_timeout_ms };
}
export function invalidResult(logId: string | null): HostError {
  return new HostError('protocol', 'invalid_performance_result', '性能操作返回了不兼容的业务结果', logId);
}
export function requireSession(value: unknown, logId: string | null, sessionId?: string): PerformanceSession {
  if (!isPerformanceSession(value) || sessionId !== undefined && value.id !== sessionId) throw invalidResult(logId);
  return value;
}
export function requireSessionId(value: string): void {
  if (!uuid(value)) throw new HostError('protocol', 'invalid_session_id', '性能会话编号必须为 UUID');
}
export function requireLimit(value: number): void {
  if (!integer(value, 1, 100)) throw new HostError('protocol', 'invalid_limit', '性能分页数量必须为 1–100');
}
export function requireAfter(value: number): void {
  if (!integer(value)) throw new HostError('protocol', 'invalid_after', '性能样本游标必须为非负安全整数');
}
