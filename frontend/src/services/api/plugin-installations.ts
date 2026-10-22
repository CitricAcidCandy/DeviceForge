import type { paths } from './generated.ts';
import type { Endpoint, JobDto } from './types.ts';
import { encodedId } from './endpoints.ts';
import { isArtifact, isJob, isRecord } from './validation.ts';

type ResponseData<T> = T extends { content: { 'application/json': { data: infer D } } } ? D : never;
export type InstalledReleaseDto = ResponseData<paths['/api/v2/plugin-installations']['get']['responses'][200]>[number];
export type InstallationPlanDto = ResponseData<paths['/api/v2/plugin-installations/plan']['post']['responses'][200]>;
export type InstallationSourceDto = paths['/api/v2/plugin-installations/plan']['post']['requestBody']['content']['application/json'];
type InstallationRequestDto = paths['/api/v2/plugin-installations']['post']['requestBody']['content']['application/json'];
type InstallationEnabledDto = paths['/api/v2/plugin-installations/{id}/enabled']['patch']['requestBody']['content']['application/json'];
type InstallationRevisionDto = paths['/api/v2/plugin-installations/{id}']['delete']['requestBody']['content']['application/json'];
type InstallationArtifactDto = ResponseData<paths['/api/v2/plugin-installations/artifacts']['post']['responses'][201]>;
type InstallationArtifactQuery = paths['/api/v2/plugin-installations/artifacts']['post']['parameters']['query'];
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function component(value: unknown): boolean {
  return isRecord(value) && text(value.id) && (value.kind === 'server' || value.kind === 'browser') && text(value.version) &&
    digest(value.revision) && text(value.entry_path) && (value.entry_url === null || text(value.entry_url));
}
function tool(value: unknown): boolean {
  return isRecord(value) && text(value.id) && text(value.version) && digest(value.sha256) && Array.isArray(value.entries) && value.entries.every(text);
}
function requirement(value: unknown): boolean {
  return isRecord(value) && text(value.component_id) && text(value.config_pointer) && text(value.title) &&
    typeof value.description === 'string' && typeof value.required === 'boolean' && typeof value.sensitive === 'boolean';
}
export function isInstalledRelease(value: unknown): value is InstalledReleaseDto {
  return isRecord(value) && text(value.id) && text(value.version) && text(value.name) && typeof value.description === 'string' &&
    digest(value.revision) && typeof value.enabled === 'boolean' &&
    ['installed', 'enabled', 'configuration_required'].includes(String(value.status)) &&
    typeof value.installed_at === 'number' && Number.isSafeInteger(value.installed_at) && value.installed_at >= 0 &&
    Array.isArray(value.components) && value.components.length > 0 && value.components.every(component) &&
    Array.isArray(value.tools) && value.tools.every(tool) && Array.isArray(value.requirements) && value.requirements.every(requirement);
}
export function isInstallationPlan(value: unknown): value is InstallationPlanDto {
  return isRecord(value) && text(value.id) && text(value.version) && digest(value.revision) &&
    Array.isArray(value.actions) && value.actions.every((item: unknown) => ['download', 'reuse', 'verify', 'install', 'preserve_previous'].includes(String(item))) &&
    Array.isArray(value.issues) && value.issues.every((item: unknown) =>
      isRecord(item) && text(item.code) && text(item.message) && typeof item.required === 'boolean');
}
const path = (id: string) => `/api/v2/plugin-installations/${encodedId(id)}`;
export const installationsEndpoint: Endpoint<void, InstalledReleaseDto[]> = {
  request: () => ({ path: '/api/v2/plugin-installations', method: 'GET' }),
  decode: (value): value is InstalledReleaseDto[] => Array.isArray(value) && value.every(isInstalledRelease),
};
export const installationPlanEndpoint: Endpoint<InstallationSourceDto, InstallationPlanDto> = {
  request: (body) => ({ path: '/api/v2/plugin-installations/plan', method: 'POST', body: JSON.stringify(body), contentType: 'application/json' }),
  decode: isInstallationPlan,
};
export const installReleaseEndpoint: Endpoint<InstallationRequestDto, JobDto> = {
  request: (body) => ({ path: '/api/v2/plugin-installations', method: 'POST', body: JSON.stringify(body), contentType: 'application/json' }), decode: isJob,
};
export const updateReleaseEndpoint: Endpoint<{ id: string; body: InstallationRequestDto }, JobDto> = {
  request: ({ id, body }) => ({ path: path(id), method: 'PUT', body: JSON.stringify(body), contentType: 'application/json' }), decode: isJob,
};
export const enableReleaseEndpoint: Endpoint<{ id: string; body: InstallationEnabledDto }, JobDto> = {
  request: ({ id, body }) => ({ path: `${path(id)}/enabled`, method: 'PATCH', body: JSON.stringify(body), contentType: 'application/json' }), decode: isJob,
};
export const uninstallReleaseEndpoint: Endpoint<{ id: string; body: InstallationRevisionDto }, JobDto> = {
  request: ({ id, body }) => ({ path: path(id), method: 'DELETE', body: JSON.stringify(body), contentType: 'application/json' }), decode: isJob,
};
export const uploadInstallationArtifactEndpoint: Endpoint<InstallationArtifactQuery & { content: Blob }, InstallationArtifactDto> = {
  request: ({ filename, content }) => ({ path: `/api/v2/plugin-installations/artifacts?${new URLSearchParams({ filename })}`,
    method: 'POST', body: content, contentType: 'application/octet-stream' }), decode: isArtifact,
};
