import { isRecord } from './validation.ts';

const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const rss = (value: unknown) => value === undefined || value === null || integer(value);

function isUnavailableMetric(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ['source', 'access', 'reason'])
    && typeof value.source === 'string' && value.source.length >= 1 && value.source.length <= 80 && !/[^a-zA-Z0-9._-]/.test(value.source)
    && (value.access === 'adb_shell' || value.access === 'root_shell')
    && (value.reason === 'permission_denied' || value.reason === 'unsupported');
}

// 健康项兼容省略或 null；至少一项必须给出真实原因，且与对应原值缺测严格一致。
function matchesMetricMissing(value: unknown, cpuMissing: boolean, memoryMissing: boolean): boolean {
  if (value === undefined || value === null) return !cpuMissing && !memoryMissing;
  if (!isRecord(value) || !onlyKeys(value, ['api_version', 'cpu', 'memory']) || value.api_version !== 1
    || !(value.cpu === undefined || value.cpu === null || isUnavailableMetric(value.cpu))
    || !(value.memory === undefined || value.memory === null || isUnavailableMetric(value.memory))) return false;
  const cpu = value.cpu !== undefined && value.cpu !== null;
  const memory = value.memory !== undefined && value.memory !== null;
  return (cpu || memory) && cpu === cpuMissing && memory === memoryMissing;
}

// 累积计数的 CPU 只允许系统计数与核数同有或同无；旧 RSS 仍可省略。
export function isRawMetricValues(value: Record<string, unknown>): boolean {
  const cpuMissing = value.system_ticks === null && value.logical_cpus === null;
  const memoryMissing = value.pss_kib === null && value.rss_kib === null;
  return (cpuMissing || integer(value.system_ticks, 1) && integer(value.logical_cpus, 1, 4096))
    && (memoryMissing || integer(value.pss_kib) && rss(value.rss_kib))
    && matchesMetricMissing(value.metric_missing, cpuMissing, memoryMissing);
}

// 会话读数没有系统累积计数；CPU 缺测时核数和两种百分比必须同时为空。
export function isReadingMetricValues(value: Record<string, unknown>): boolean {
  const cpuMissing = value.logical_cpus === null;
  const memoryMissing = value.pss_kib === null && value.rss_kib === null;
  return (cpuMissing ? value.cpu_share_percent === null && value.cpu_core_percent === null : integer(value.logical_cpus, 1, 4096))
    && (memoryMissing || integer(value.pss_kib) && rss(value.rss_kib))
    && matchesMetricMissing(value.metric_missing, cpuMissing, memoryMissing);
}
