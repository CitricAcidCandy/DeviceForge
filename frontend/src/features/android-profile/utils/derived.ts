import { isRecord } from '../../../shared/api/validation.ts';
import { onlyKeys } from '../../../shared/jobs/index.ts';
import { boundedText, invalidProfile } from './rules.ts';
import type { ProfileDerived, ProfileMetrics } from '../types/index.ts';

const fields = ['api_version', 'cpu_share_percent', 'cpu_core_percent', 'cpu_reason', 'fps', 'fps_reason', 'battery_net_power_mw', 'battery_reason'];
const reason = (value: unknown): value is string => boundedText(value) && value.trim().length > 0;
const finite = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
const consistent = (value: number, expected: number) => Math.abs(value - expected) <= 1e-9 * Math.max(1, Math.abs(value), Math.abs(expected));

function validCpu(value: Record<string, unknown>, metrics: ProfileMetrics): boolean {
  if (value.cpu_share_percent === null || value.cpu_core_percent === null) {
    return value.cpu_share_percent === null && value.cpu_core_percent === null && reason(value.cpu_reason);
  }
  return metrics.system_ticks !== null && metrics.logical_cpus !== null
    && finite(value.cpu_share_percent, 0, 100) && finite(value.cpu_core_percent, 0, metrics.logical_cpus * 100)
    && value.cpu_reason === null && consistent(value.cpu_core_percent, value.cpu_share_percent * metrics.logical_cpus);
}

function validFps(value: Record<string, unknown>, metrics: ProfileMetrics): boolean {
  if (value.fps === null) return reason(value.fps_reason);
  const window = metrics.frame_window;
  return finite(value.fps, 0, 1000) && value.fps_reason === null && window !== undefined && window !== null
    && consistent(value.fps, window.frames * 1000 / window.duration_ms);
}

function validBatteryPower(value: Record<string, unknown>, metrics: ProfileMetrics): boolean {
  if (value.battery_net_power_mw === null) return reason(value.battery_reason);
  const battery = metrics.device_observation?.battery;
  if (!finite(value.battery_net_power_mw, -5000000, 5000000) || value.battery_reason !== null
    || !battery || battery.current_ua === undefined || battery.current_ua === null || battery.current_polarity === 'unknown') return false;
  const chargingCurrent = battery.current_polarity === 'positive_charging' ? battery.current_ua : -battery.current_ua;
  return consistent(value.battery_net_power_mw, battery.voltage_uv * chargingCurrent / 1e9);
}

// 派生对象与原计数分开消费；只核资格与一致性，不重算或替换服务器结果。
export function decodeProfileDerived(value: unknown, metrics: ProfileMetrics, logId: string | null): ProfileDerived {
  if (!isProfileDerived(value, metrics)) throw invalidProfile(logId);
  return value;
}

function isProfileDerived(value: unknown, metrics: ProfileMetrics): value is ProfileDerived {
  return isRecord(value) && Object.keys(value).length === fields.length && onlyKeys(value, fields) && value.api_version === 1
    && validCpu(value, metrics) && validFps(value, metrics) && validBatteryPower(value, metrics);
}

// 只有新派生 CPU 有值时核相邻基线；历史原始样本不因此增加资格要求。
export function hasProfileCpuBaseline(current: ProfileMetrics, previous: ProfileMetrics | undefined): boolean {
  if (!previous || current.system_ticks === null || current.logical_cpus === null
    || previous.system_ticks === null || previous.logical_cpus === null
    || current.pid !== previous.pid || current.process_start_ticks !== previous.process_start_ticks
    || current.logical_cpus !== previous.logical_cpus || current.captured_at <= previous.captured_at
    || current.process_ticks < previous.process_ticks || current.system_ticks <= previous.system_ticks) return false;
  return current.process_ticks - previous.process_ticks <= current.system_ticks - previous.system_ticks;
}
