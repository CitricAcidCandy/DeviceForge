import { pluginReleaseHeaders, withRequestHeaders } from '../services/api/index.ts';
import type { ApiClient, PluginInfo, RequestSpec } from '../services/api/index.ts';
import type { PluginInstallation } from '../features/plugin-installations/index.ts';

function operation(request: RequestSpec): string | null {
  if (typeof request.body !== 'string') return null;
  const value: unknown = JSON.parse(request.body);
  return value && typeof value === 'object' && 'operation' in value && typeof value.operation === 'string'
    ? value.operation : null;
}

// 产品请求在提交钩子之后按真实目标解析；浏览器组件另用固定修订客户端。
export function createReleaseRequestClient(client: ApiClient, options: {
  readonly installations: (signal: AbortSignal) => Promise<readonly PluginInstallation[]>;
  readonly plugins: () => readonly PluginInfo[];
}): ApiClient {
  return withRequestHeaders(client, async (request, signal) => {
    const bodyRequest = request.method === 'POST' && ['/api/v2/jobs', '/api/v2/sessions', '/api/v2/device-actions'].includes(request.path);
    const refresh = request.method === 'POST' ? /^\/api\/v2\/device-providers\/([^/]+)\/refresh$/.exec(request.path) : null;
    if (!bodyRequest && !refresh) return {};
    const records = await options.installations(signal);
    const provider = refresh?.[1] ? decodeURIComponent(refresh[1]) : null;
    let owner = provider;
    const target = bodyRequest && request.path !== '/api/v2/device-actions' ? operation(request) : null;
    if (request.path === '/api/v2/device-actions' && typeof request.body === 'string') {
      const value: unknown = JSON.parse(request.body);
      if (value && typeof value === 'object' && 'provider_id' in value && typeof value.provider_id === 'string') owner = value.provider_id;
    }
    const candidates = records.filter((record) => record.components.some((component) =>
      component.kind === 'server' && (component.id === owner || (target !== null && (
        options.plugins().some((plugin) => plugin.id === component.id && plugin.operations.includes(target)) ||
        target.startsWith(`plugin.${component.id}.`)
      ))),
    ));
    if (candidates.length > 1) throw new Error('请求目标属于多个功能发布，请刷新安装目录');
    const release = candidates[0];
    return release ? pluginReleaseHeaders(release) : {};
  });
}
