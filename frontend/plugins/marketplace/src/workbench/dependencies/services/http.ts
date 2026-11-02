import {
  ApiError, eventsEndpoint, installPluginDependenciesEndpoint, jobEndpoint, pluginDependenciesEndpoint, scanPluginDependenciesEndpoint,
} from '../../api/index.ts';
import type { ApiClient, ApiResult, DependencyCommandDto, DependencyTaskDto } from '../../api/index.ts';
import type { DependencyCommand, DependencyTarget, PluginDependenciesView } from '../types/index.ts';
import { publicJob } from '../../api/jobs.ts';

function command(value: DependencyCommand): DependencyCommandDto {
  return { target: value.target, body: { expected_revision: value.expected_revision,
    ...(value.dependency_ids === undefined ? {} : { dependency_ids: [...value.dependency_ids] }) } };
}

export function createPluginDependenciesHttp(client: ApiClient) {
  async function job(pending: Promise<ApiResult<DependencyTaskDto>>) {
    const result = await pending;
    return { data: publicJob(result.data, result.logId), logId: result.logId };
  }
  return {
    async get(value: DependencyTarget, signal: AbortSignal) {
      const result = await client.call(pluginDependenciesEndpoint, value, signal);
      const canonical = result.data.target;
      // 完整发布拥有的独立组件由宿主归并到 release，后续写操作使用该公开目标。
      if ((canonical.kind !== value.kind || canonical.id !== value.id) &&
        !(value.kind !== 'release' && canonical.kind === 'release'))
        throw new ApiError('protocol', 'dependency_target_mismatch', '依赖视图不属于当前插件', null, result.logId);
      const data: PluginDependenciesView = { target: canonical, revision: result.data.revision,
        dependencies: result.data.dependencies.map((item) => ({ ...item })), ready: result.data.ready };
      return { data, logId: result.logId };
    },
    scan: (value: DependencyCommand, signal: AbortSignal) => job(client.call(scanPluginDependenciesEndpoint, command(value), signal)),
    install: (value: DependencyCommand, signal: AbortSignal) => job(client.call(installPluginDependenciesEndpoint, command(value), signal)),
    getJob: (id: string, signal: AbortSignal) => job(client.call(jobEndpoint, id, signal)),
    getEvents: (id: string, after: number, signal: AbortSignal) => client.call(eventsEndpoint, { id, query: { after } }, signal),
  };
}
