import { isOperationExecution } from './operation-execution-validation.ts';
import type {
  ArtifactDto,
  JobDto,
  JobEventDto,
  OperationDto,
  PackageInfo,
  PluginInfo,
} from './types.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isArrayOf<T>(
  guard: (value: unknown) => value is T,
): (value: unknown) => value is T[] {
  return (value): value is T[] => Array.isArray(value) && value.every(guard);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function jobStatus(value: unknown): boolean {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}
export function isOperation(value: unknown): value is OperationDto {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    'input_schema' in value &&
    isOperationExecution(value.execution)
  );
}
export function isJob(value: unknown): value is JobDto {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.operation === 'string' &&
    finite(value.created_at) &&
    'input' in value &&
    jobStatus(value.status) &&
    (value.error === undefined || value.error === null || typeof value.error === 'string')
  );
}
export function isJobEvent(value: unknown): value is JobEventDto {
  return (
    isRecord(value) &&
    typeof value.job_id === 'string' &&
    finite(value.sequence) &&
    finite(value.timestamp) &&
    jobStatus(value.status)
  );
}
export function isPluginInfo(value: unknown): value is PluginInfo {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    typeof value.generation === 'string' &&
    typeof value.protected === 'boolean' &&
    (value.state === 'loaded' || value.state === 'draining' || value.state === 'unloaded') &&
    isArrayOf((item): item is string => typeof item === 'string')(value.operations) &&
    // 后端协议 3 已要求此字段；旧生成类型更新后仍使用同一校验。
    typeof value.cleanup_failed === 'boolean'
  );
}
export function isArtifact(value: unknown): value is ArtifactDto {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.filename === 'string' &&
    typeof value.media_type === 'string' &&
    typeof value.sha256 === 'string' &&
    finite(value.created_at) &&
    finite(value.size) &&
    value.size >= 0
  );
}
export function isPackageInfo(value: unknown): value is PackageInfo {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    (value.kind === 'server' || value.kind === 'browser') &&
    typeof value.entry_path === 'string' &&
    typeof value.runtime === 'string' &&
    finite(value.installed_at) &&
    (value.api_version === undefined || value.api_version === null || finite(value.api_version)) &&
    (value.entry_url === undefined ||
      value.entry_url === null ||
      typeof value.entry_url === 'string')
  );
}
