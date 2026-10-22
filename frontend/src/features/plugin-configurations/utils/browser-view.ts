import type { ConfigurationDefinition } from '../../../plugin-sdk/index.ts';
import {
  cloneSchemaValue,
  mapSchemaSecrets,
  mapSensitivePaths,
  redactSchemaDefaults,
  validateSchema,
} from '../../../utils/schema.ts';
import type { BrowserConfigurationRecord } from '../types/browser.ts';
import type { PluginConfigurationView } from '../types/index.ts';

export function browserConfigurationView(
  id: string,
  definition: ConfigurationDefinition | null,
  stored: BrowserConfigurationRecord | null,
): PluginConfigurationView {
  const values = cloneSchemaValue(stored?.values ?? definition?.defaults ?? {});
  const fieldErrors = definition ? validateSchema(definition.schema, values) : [];
  const versionMatches = !stored || stored.version === definition?.version;
  return {
    kind: 'browser',
    id,
    definition,
    values,
    revision: stored?.revision ?? 'defaults',
    appliedRevision: stored?.applied ?? 'defaults',
    pendingReload:
      !!definition &&
      definition.apply_policy === 'plugin_reload' &&
      !!stored &&
      stored.revision !== stored.applied,
    compatible: versionMatches && fieldErrors.length === 0,
    fieldErrors: [
      ...fieldErrors,
      ...(versionMatches
        ? []
        : [{ path: '', message: '配置版本与插件声明不兼容，请恢复默认或修正配置' }]),
    ],
    source: stored ? 'managed' : 'defaults',
  };
}
export function redactBrowserConfiguration(
  snapshot: PluginConfigurationView,
  stored: BrowserConfigurationRecord | null,
): PluginConfigurationView {
  const historical = stored?.sensitivePaths ?? [];
  return snapshot.definition
    ? {
        ...snapshot,
        values: mapSensitivePaths(
          mapSchemaSecrets(snapshot.definition.schema, snapshot.values),
          historical,
        ),
        definition: {
          ...snapshot.definition,
          schema: redactSchemaDefaults(snapshot.definition.schema),
          defaults: mapSchemaSecrets(snapshot.definition.schema, snapshot.definition.defaults),
        },
      }
    : { ...snapshot, values: mapSensitivePaths(snapshot.values, historical) };
}
