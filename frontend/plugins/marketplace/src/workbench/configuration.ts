import { ApiError } from '@deviceforge/plugin-sdk';
import type { ConfigurationDefinition, HostContext, JsonValue } from '@deviceforge/plugin-sdk';
import { isRecord } from '@deviceforge/business-kit/api';
import { createBrowserManagementClient } from '../browser-management.ts';
import { managementResult } from './packages.ts';
import { createServerConfigurations } from './configuration-server.ts';
import { isSchemaValue } from './schema.ts';
import type { ApiClient } from './api/index.ts';
export interface PluginConfigurationTarget { readonly kind: 'server' | 'browser'; readonly id: string }
export interface PluginConfigurationView {
  readonly kind: 'server' | 'browser'; readonly id: string; readonly definition: ConfigurationDefinition | null;
  readonly values: JsonValue; readonly revision: string; readonly appliedRevision: string;
  readonly pendingReload: boolean; readonly compatible: boolean;
  readonly fieldErrors: readonly { readonly path: string; readonly message: string }[];
  readonly source: 'legacy' | 'managed' | 'defaults';
}
export interface PluginConfigurationController {
  get(target: PluginConfigurationTarget, signal: AbortSignal): Promise<PluginConfigurationView>;
  save(target: PluginConfigurationTarget, revision: string, values: JsonValue, signal: AbortSignal): Promise<PluginConfigurationView>;
  reset(target: PluginConfigurationTarget, revision: string, signal: AbortSignal): Promise<PluginConfigurationView>;
  apply(target: PluginConfigurationTarget, revision: string, signal: AbortSignal): Promise<PluginConfigurationView>;
}
function isView(value: unknown): value is PluginConfigurationView {
  if (!isRecord(value) || (value.kind !== 'server' && value.kind !== 'browser') ||
      typeof value.id !== 'string' || !isSchemaValue(value.values) || typeof value.revision !== 'string' ||
      typeof value.appliedRevision !== 'string' || typeof value.pendingReload !== 'boolean' ||
      typeof value.compatible !== 'boolean' || !['legacy', 'managed', 'defaults'].includes(String(value.source)) ||
      !Array.isArray(value.fieldErrors) || !value.fieldErrors.every((item: unknown) =>
        isRecord(item) && typeof item.path === 'string' && typeof item.message === 'string')) return false;
  return value.definition === null || isRecord(value.definition) &&
    typeof value.definition.version === 'number' && isSchemaValue(value.definition.schema) &&
    isSchemaValue(value.definition.defaults) &&
    ['next_invocation', 'plugin_reload'].includes(String(value.definition.apply_policy));
}
export function createMarketplaceConfigurations(context: HostContext, api: ApiClient): PluginConfigurationController {
  const server = createServerConfigurations(api), browser = createBrowserManagementClient(context);
  async function call(id: string, input: Parameters<typeof browser.request>[0], signal: AbortSignal) {
    const result = await browser.request(input, signal), value = managementResult(result.data, result.logId);
    if (!isView(value) || value.kind !== 'browser' || value.id !== id)
      throw new ApiError('protocol', 'marketplace_configuration_mismatch', '配置回执不属于当前浏览器插件', null, result.logId);
    return value;
  }
  return {
    get: (target, signal) => target.kind === 'server' ? server.get(target, signal) :
      call(target.id, { action: 'configuration', operation: 'get', id: target.id }, signal),
    save: (target, revision, values, signal) => target.kind === 'server' ? server.save(target, revision, values, signal) :
      call(target.id, { action: 'configuration', operation: 'save', id: target.id, revision, values }, signal),
    reset: (target, revision, signal) => target.kind === 'server' ? server.reset(target, revision, signal) :
      call(target.id, { action: 'configuration', operation: 'reset', id: target.id, revision }, signal),
    apply: (target, revision, signal) => target.kind === 'server' ? server.apply(target, revision, signal) :
      call(target.id, { action: 'configuration', operation: 'apply', id: target.id, revision }, signal),
  };
}
