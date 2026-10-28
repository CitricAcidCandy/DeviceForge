import type { WebPlugin } from '../plugin-sdk/index.ts';
import { isPluginContributions, validatePluginContributions } from './contributions.ts';
import { isJsonValue } from '../plugin-sdk/json.ts';

export function validateContributions(plugins: readonly WebPlugin[]): void {
  const ids = new Set<string>();
  const panels = new Set<string>();
  for (const plugin of plugins) {
    if (
      plugin.apiVersion !== 2 ||
      !/^[a-z][a-z0-9._-]{0,99}$/.test(plugin.id) ||
      !plugin.version.trim()
    ) {
      throw new Error('插件标识、版本或协议无效');
    }
    if (ids.has(plugin.id)) throw new Error(`插件重复：${plugin.id}`);
    ids.add(plugin.id);
    if (plugin.contributions) validatePluginContributions(plugin.id, plugin.contributions);
    const configuration = plugin.configuration;
    if (configuration && (!Number.isSafeInteger(configuration.version) || configuration.version < 1 ||
      !isJsonValue(configuration.schema) || !isJsonValue(configuration.defaults) ||
      !['next_invocation', 'plugin_reload'].includes(configuration.apply_policy))) throw new Error('插件配置声明无效');
    for (const panel of plugin.panels) {
      if (
        !panel.id.startsWith(`${plugin.id}.`) ||
        !/^[a-z][a-z0-9._-]{0,199}$/.test(panel.id) ||
        panels.has(panel.id) ||
        !panel.title.trim()
      ) {
        throw new Error(`面板贡献无效或重复：${panel.id}`);
      }
      panels.add(panel.id);
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isWebPlugin(value: unknown): value is WebPlugin {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    value.apiVersion === 2 &&
    (value.configuration === undefined || (record(value.configuration) && typeof value.configuration.version === 'number' &&
      isJsonValue(value.configuration.schema) && isJsonValue(value.configuration.defaults) &&
      (value.configuration.apply_policy === 'next_invocation' || value.configuration.apply_policy === 'plugin_reload'))) &&
    (value.contributions === undefined || isPluginContributions(value.contributions)) &&
    (value.activate === undefined || typeof value.activate === 'function') &&
    (value.deactivate === undefined || typeof value.deactivate === 'function') &&
    Array.isArray(value.panels) &&
    value.panels.every(
      (panel: unknown) =>
        record(panel) &&
        typeof panel.id === 'string' &&
        typeof panel.title === 'string' &&
        typeof panel.mount === 'function',
    )
  );
}
export function readPluginModule(value: unknown): WebPlugin {
  const candidate = record(value) && 'default' in value ? value.default : value;
  const normalized = record(candidate) && record(candidate.configuration) && candidate.configuration.apply_policy === undefined
    ? { ...candidate, configuration: { ...candidate.configuration, apply_policy: 'next_invocation' } }
    : candidate;
  if (!isWebPlugin(normalized)) throw new Error('模块不符合浏览器插件 SDK v2');
  validateContributions([normalized]);
  return normalized;
}
