import { ApiError, encodedId, jobEndpoint } from '../../../services/api/index.ts';
import type { ApiClient, Endpoint } from '../../../services/api/index.ts';
import type { TaskRecord } from '../../../shared/jobs/index.ts';
import type {
  DependencyCommand, DependencyTarget, PluginDependency, PluginDependenciesView,
} from '../types/index.ts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
function target(value: unknown): value is DependencyTarget {
  return record(value) && text(value.id) &&
    (value.kind === 'release' || value.kind === 'server' || value.kind === 'browser');
}
function dependency(value: unknown): value is PluginDependency {
  return record(value) && text(value.id) && text(value.name) && typeof value.version_requirement === 'string' &&
    typeof value.required === 'boolean' && typeof value.installable === 'boolean' &&
    (value.status === 'ready' || value.status === 'missing' || value.status === 'incompatible' || value.status === 'failed') &&
    (value.source === null || value.source === 'environment' || value.source === 'shared' || value.source === 'local') &&
    nullableText(value.version) && nullableText(value.message);
}
export function isPluginDependenciesView(value: unknown): value is PluginDependenciesView {
  return record(value) && target(value.target) && text(value.revision) && typeof value.ready === 'boolean' &&
    Array.isArray(value.dependencies) && value.dependencies.every(dependency) &&
    new Set(value.dependencies.map((item: PluginDependency) => item.id)).size === value.dependencies.length &&
    value.ready === value.dependencies.every((item: PluginDependency) => !item.required || item.status === 'ready');
}
function task(value: unknown): value is TaskRecord {
  return record(value) && text(value.id) && text(value.operation) &&
    (value.status === 'queued' || value.status === 'running' || value.status === 'succeeded' ||
      value.status === 'failed' || value.status === 'cancelled') &&
    (value.error === undefined || nullableText(value.error));
}
function path(value: DependencyTarget): string {
  if (!target(value)) throw new ApiError('protocol', 'invalid_dependency_target', '插件依赖目标无效');
  return `/api/v2/plugin-dependencies/${value.kind}/${encodedId(value.id)}`;
}
const viewEndpoint: Endpoint<DependencyTarget, PluginDependenciesView> = {
  request: (value) => ({ path: path(value), method: 'GET' }),
  decode: isPluginDependenciesView,
};
function commandEndpoint(action: 'scan' | 'install'): Endpoint<DependencyCommand, TaskRecord> {
  return {
    request: ({ target: value, expected_revision, dependency_ids }) => {
      if (!text(expected_revision) || (dependency_ids !== undefined &&
        (!dependency_ids.length || !dependency_ids.every(text) || new Set(dependency_ids).size !== dependency_ids.length)))
        throw new ApiError('protocol', 'invalid_dependency_command', '依赖操作需要当前修订和有效依赖标识');
      return {
        path: `${path(value)}/${action}`, method: 'POST', contentType: 'application/json',
        body: JSON.stringify({ expected_revision, ...(dependency_ids === undefined ? {} : { dependency_ids }) }),
      };
    },
    decode: task,
  };
}
const scanEndpoint = commandEndpoint('scan');
const installEndpoint = commandEndpoint('install');

export function createPluginDependenciesHttp(client: ApiClient) {
  return {
    async get(value: DependencyTarget, signal: AbortSignal) {
      const result = await client.call(viewEndpoint, value, signal);
      if (result.data.target.kind !== value.kind || result.data.target.id !== value.id)
        throw new ApiError('protocol', 'dependency_target_mismatch', '依赖视图不属于当前插件', null, result.logId);
      return result;
    },
    scan: (value: DependencyCommand, signal: AbortSignal) => client.call(scanEndpoint, value, signal),
    install: (value: DependencyCommand, signal: AbortSignal) => client.call(installEndpoint, value, signal),
    getJob: (id: string, signal: AbortSignal) => client.call(jobEndpoint, id, signal),
  };
}
