import type { Endpoint, PluginConfigurationDto, ConfigurationPatchDto, ConfigurationRevisionDto } from './types.ts';
import { encodedId } from './endpoints.ts';
import { isRecord } from './validation.ts';
import { isSchemaValue } from '../../utils/schema.ts';

export function isPluginConfiguration(value: unknown): value is PluginConfigurationDto {
  if (!isRecord(value) || value.kind !== 'server' || typeof value.id !== 'string' || !isSchemaValue(value.values) ||
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || typeof value.applied_revision !== 'number' ||
    typeof value.pending_reload !== 'boolean' || typeof value.compatible !== 'boolean' ||
    !['legacy', 'managed', 'defaults'].includes(String(value.source)) || !Array.isArray(value.field_errors) ||
    !value.field_errors.every((field: unknown) => isRecord(field) && typeof field.path === 'string' && typeof field.message === 'string')) return false;
  if (value.definition === null) return true;
  const definition = value.definition;
  return isRecord(definition) && typeof definition.version === 'number' && Number.isSafeInteger(definition.version) &&
    isSchemaValue(definition.schema) && isSchemaValue(definition.defaults) &&
    (definition.apply_policy === 'next_invocation' || definition.apply_policy === 'plugin_reload');
}
const path = (id: string) => `/api/v2/plugin-configurations/server/${encodedId(id)}`;
export const pluginConfigurationEndpoint: Endpoint<string, PluginConfigurationDto> = {
  request: (id) => ({ path: path(id), method: 'GET' }), decode: isPluginConfiguration,
};
export const pluginConfigurationsEndpoint: Endpoint<void, PluginConfigurationDto[]> = {
  request: () => ({ path: '/api/v2/plugin-configurations?kind=server', method: 'GET' }),
  decode: (value): value is PluginConfigurationDto[] => Array.isArray(value) && value.every(isPluginConfiguration),
};
export const patchPluginConfigurationEndpoint: Endpoint<{ id: string; body: ConfigurationPatchDto }, PluginConfigurationDto> = {
  request: ({ id, body }) => ({ path: path(id), method: 'PATCH', body: JSON.stringify(body), contentType: 'application/json' }), decode: isPluginConfiguration,
};
export const resetPluginConfigurationEndpoint: Endpoint<{ id: string; body: ConfigurationRevisionDto }, PluginConfigurationDto> = {
  request: ({ id, body }) => ({ path: `${path(id)}/reset`, method: 'POST', body: JSON.stringify(body), contentType: 'application/json' }), decode: isPluginConfiguration,
};
export const applyPluginConfigurationEndpoint: Endpoint<{ id: string; body: ConfigurationRevisionDto }, PluginConfigurationDto> = {
  request: ({ id, body }) => ({ path: `${path(id)}/apply`, method: 'POST', body: JSON.stringify(body), contentType: 'application/json' }), decode: isPluginConfiguration,
};
