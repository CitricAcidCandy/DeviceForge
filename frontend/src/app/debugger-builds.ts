import { createInstallationGateway } from '../features/plugin-installations/index.ts';
import { packagesEndpoint } from '../services/api/index.ts';
import type { ApiClient } from '../services/api/index.ts';
import type { HostResult, JsonValue } from '../plugin-sdk/index.ts';

export interface DebuggerRunningBuild {
  readonly pluginId: string;
  readonly generation: string;
  readonly version: string;
  readonly installationId: string | null;
  readonly revision: string | null;
}

/** 安装身份来自共同目录，运行身份取自实际加载时记录；不返回服务器文件路径。 */
export function createDebuggerBuildDirectory(client: ApiClient, running: () => readonly DebuggerRunningBuild[]) {
  const gateway = createInstallationGateway(client);
  return async (caller: AbortSignal): Promise<HostResult<JsonValue>> => {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(5000)]);
    const [installed, browser, server] = await Promise.all([
      gateway.list(signal), client.call(packagesEndpoint, 'browser', signal), client.call(packagesEndpoint, 'server', signal),
    ]);
    signal.throwIfAborted();
    const builds = running();
    return { logId: installed.logId, data: {
      installations: installed.data.map(item => ({ id: item.id, version: item.version,
        revision: item.revision, enabled: item.enabled, status: item.status,
        components: item.components.map(component => {
          const loaded = component.kind === 'browser' ? builds.find(build => build.pluginId === component.id) : undefined;
          return { id: component.id, kind: component.kind, version: component.version, revision: component.revision,
            running_generation: loaded?.generation ?? null, running_revision: loaded?.revision ?? null,
            build_state: !loaded ? 'not_observed' : loaded.revision === component.revision ? 'current' : 'refresh_required' };
        }) })),
      standalone: [...browser.data, ...server.data].map(item => ({ id: item.id, version: item.version,
        kind: item.kind, installed_at: item.installed_at,
        digest: null, digest_status: 'not_provided_by_legacy_package_catalog' })),
      running: builds.map(build => ({ plugin_id: build.pluginId, generation: build.generation,
        version: build.version, installation_id: build.installationId, revision: build.revision })),
      note: '完整功能以安装修订识别构建；旧独立包目录没有摘要时明确标注未知，不按相同版本号猜测字节相同',
    } };
  };
}
