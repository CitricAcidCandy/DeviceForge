import type { paths } from './generated.ts';
import { encodedId } from './endpoints.ts';
import { ApiError } from './errors.ts';
import type { Endpoint } from './types.ts';
import { isRecord } from './validation.ts';

type ResponseData<T> = T extends { content: { 'application/json': { data: infer D } } } ? D : never;
export type PluginDependenciesDto = ResponseData<paths['/api/v2/plugin-dependencies/{target_kind}/{id}']['get']['responses'][200]>;
export type DependencyTargetDto = PluginDependenciesDto['target'];
type ChangeBody = paths['/api/v2/plugin-dependencies/{target_kind}/{id}/scan']['post']['requestBody']['content']['application/json'];
export type DependencyChangeDto = Omit<ChangeBody, 'dependency_ids'> & Partial<Pick<ChangeBody, 'dependency_ids'>>;
export type DependencyTaskDto = Pick<ResponseData<paths['/api/v2/plugin-dependencies/{target_kind}/{id}/install']['post']['responses'][202]>,
  'id' | 'operation' | 'status' | 'result' | 'error'>;
export interface DependencyCommandDto {
  readonly target: DependencyTargetDto;
  readonly body: DependencyChangeDto;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export function isDependencyIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,98}$/.test(value) && !value.startsWith('builtin.');
}
const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';
function target(value: unknown): value is DependencyTargetDto {
  return isRecord(value) && text(value.id) &&
    (value.kind === 'release' || value.kind === 'server' || value.kind === 'browser');
}
function dependency(value: unknown): value is PluginDependenciesDto['dependencies'][number] {
  return isRecord(value) && isDependencyIdentifier(value.id) && text(value.name) && typeof value.version_requirement === 'string' &&
    typeof value.required === 'boolean' && typeof value.installable === 'boolean' &&
    (value.status === 'ready' || value.status === 'missing' || value.status === 'incompatible' || value.status === 'failed') &&
    (value.source === null || value.source === 'environment' || value.source === 'shared' || value.source === 'local') &&
    nullableText(value.version) && nullableText(value.message);
}
export function isPluginDependencies(value: unknown): value is PluginDependenciesDto {
  return isRecord(value) && target(value.target) && text(value.revision) && typeof value.ready === 'boolean' &&
    Array.isArray(value.dependencies) && value.dependencies.every(dependency) &&
    new Set(value.dependencies.map((item: PluginDependenciesDto['dependencies'][number]) => item.id)).size === value.dependencies.length &&
    value.ready === value.dependencies.every((item: PluginDependenciesDto['dependencies'][number]) => !item.required || item.status === 'ready');
}
function task(value: unknown): value is DependencyTaskDto {
  return isRecord(value) && text(value.id) && text(value.operation) &&
    (value.status === 'queued' || value.status === 'running' || value.status === 'succeeded' ||
      value.status === 'failed' || value.status === 'cancelled') &&
    (value.error === undefined || nullableText(value.error));
}
function path(value: DependencyTargetDto): string {
  if (!target(value)) throw new ApiError('protocol', 'invalid_dependency_target', '插件依赖目标无效');
  return `/api/v2/plugin-dependencies/${value.kind}/${encodedId(value.id)}`;
}
export const pluginDependenciesEndpoint: Endpoint<DependencyTargetDto, PluginDependenciesDto> = {
  request: (value) => ({ path: path(value), method: 'GET' }), decode: isPluginDependencies,
};
function commandEndpoint(action: 'scan' | 'install'): Endpoint<DependencyCommandDto, DependencyTaskDto> {
  return {
    request: ({ target: value, body }) => {
      if (!text(body.expected_revision) || (body.dependency_ids !== undefined &&
        (!body.dependency_ids.length || !body.dependency_ids.every(isDependencyIdentifier) || new Set(body.dependency_ids).size !== body.dependency_ids.length)))
        throw new ApiError('protocol', 'invalid_dependency_command', '依赖操作需要当前修订和有效依赖标识');
      return { path: `${path(value)}/${action}`, method: 'POST', contentType: 'application/json', body: JSON.stringify(body) };
    }, decode: task,
  };
}
export const scanPluginDependenciesEndpoint = commandEndpoint('scan');
export const installPluginDependenciesEndpoint = commandEndpoint('install');
