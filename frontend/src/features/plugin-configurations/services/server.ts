import { applyPluginConfigurationEndpoint, patchPluginConfigurationEndpoint, pluginConfigurationEndpoint, resetPluginConfigurationEndpoint } from '../../../services/api/index.ts';
import type { ApiClient, PluginConfigurationDto } from '../../../services/api/index.ts';
import { isSchemaValue, mapSchemaSecrets, redactSchemaDefaults } from '../../../utils/schema.ts';
import type { PluginConfigurationController, PluginConfigurationView } from '../types/index.ts';

function view(value: PluginConfigurationDto): PluginConfigurationView {
  if (!isSchemaValue(value.values)) throw new Error('服务器配置值不是有效 JSON');
  const definition = value.definition;
  if (definition && (!isSchemaValue(definition.schema) || !isSchemaValue(definition.defaults))) throw new Error('服务器配置声明不是有效 JSON');
  return { kind: 'server', id: value.id, values: definition && isSchemaValue(definition.schema) ? mapSchemaSecrets(definition.schema, value.values) : value.values, revision: String(value.revision), appliedRevision: String(value.applied_revision),
    definition: definition && isSchemaValue(definition.schema) && isSchemaValue(definition.defaults) ? { version: definition.version, schema: redactSchemaDefaults(definition.schema), defaults: mapSchemaSecrets(definition.schema, definition.defaults), apply_policy: definition.apply_policy } : null,
    compatible: value.compatible, pendingReload: value.pending_reload, fieldErrors: value.field_errors, source: value.source };
}
function revision(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('配置修订号无效，请重新读取');
  return result;
}
export function createServerConfigurations(client: ApiClient): PluginConfigurationController {
  return {
    async get(target, signal) { return view((await client.call(pluginConfigurationEndpoint, target.id, signal)).data); },
    async save(target, expected, values, signal) { return view((await client.call(patchPluginConfigurationEndpoint, { id: target.id, body: { expected_revision: revision(expected), patch: values } }, signal)).data); },
    async reset(target, expected, signal) { return view((await client.call(resetPluginConfigurationEndpoint, { id: target.id, body: { expected_revision: revision(expected) } }, signal)).data); },
    async apply(target, expected, signal) { return view((await client.call(applyPluginConfigurationEndpoint, { id: target.id, body: { expected_revision: revision(expected) } }, signal)).data); },
  };
}
