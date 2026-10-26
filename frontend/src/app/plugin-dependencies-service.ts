import { HostError } from '../plugin-sdk/index.ts';
import type { HostContext, JsonValue } from '../plugin-sdk/index.ts';
import { isJsonValue } from '../plugin-sdk/json.ts';
import { createPluginDependenciesHttp } from '../features/plugin-dependencies/index.ts';
import type { DependencyTarget } from '../features/plugin-dependencies/index.ts';
import { isDependencyIdentifier } from '../services/api/index.ts';
import type { ApiClient } from '../services/api/index.ts';
import type { ExtensionRegistry } from '../plugins/extensions/registry.ts';
import { publicCall } from './public-api.ts';

function requestTarget(value: JsonValue): DependencyTarget {
  const invalid = () => new HostError('protocol', 'invalid_plugin_dependencies_request', '依赖服务仅接受 get 动作及有效的插件目标');
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.action !== 'get' ||
      Object.keys(value).some((key) => key !== 'action' && key !== 'target')) throw invalid();
  const target = value.target;
  if (target === undefined || target === null || typeof target !== 'object' || Array.isArray(target) ||
      Object.keys(target).some((key) => key !== 'kind' && key !== 'id') || !isDependencyIdentifier(target.id) ||
      (target.kind !== 'release' && target.kind !== 'server' && target.kind !== 'browser')) throw invalid();
  return { kind: target.kind, id: target.id };
}

function publicView(value: unknown): JsonValue {
  if (!isJsonValue(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024)
    throw new HostError('protocol', 'invalid_plugin_dependencies_result', '依赖服务响应不是有界 JSON 数据');
  return structuredClone(value);
}

export function registerPluginDependenciesService(registry: ExtensionRegistry, context: HostContext, client: ApiClient) {
  const http = createPluginDependenciesHttp(client);
  return registry.register({ pluginId: 'host', generation: 0, context }, {
    services: [{ id: 'host.plugin-dependencies', version: '1',
      invoke: async (value, _context, signal) => publicCall(
        http.get(requestTarget(value), AbortSignal.any([signal, context.signal])), publicView,
      ),
    }],
  });
}
