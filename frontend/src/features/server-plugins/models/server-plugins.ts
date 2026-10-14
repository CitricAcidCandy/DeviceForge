import {
  loadPluginEndpoint,
  pluginsEndpoint,
  unloadPluginEndpoint,
} from '../../../services/api/index.ts';
import type { ApiClient, ApiResult, PluginInfo } from '../../../services/api/index.ts';
import { createLatestResource } from '../../../shared/lifecycle/latest.ts';

export function createServerPlugins(
  client: ApiClient,
  refreshPublished: (signal: AbortSignal, id: string) => Promise<unknown>,
) {
  const resource = createLatestResource<PluginInfo[]>();
  const lifetime = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const combined = (signal: AbortSignal) =>
    closed ? AbortSignal.abort() : AbortSignal.any([signal, lifetime.signal]);
  const refresh = (signal: AbortSignal) =>
    resource.run((current) => client.call(pluginsEndpoint, undefined, combined(current)), signal);
  async function reconcile(id: string) {
    if (closed || lifetime.signal.aborted) return;
    // 使用独立生命周期信号：用户取消管理等待后仍须重查真实状态。
    const results = await Promise.allSettled([
      refresh(lifetime.signal),
      refreshPublished(lifetime.signal, id),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        '服务器目录重新查询失败',
      );
  }
  function mutate(
    id: string,
    action: 'load' | 'unload',
    signal: AbortSignal,
  ): Promise<ApiResult<PluginInfo>> {
    const run = async () => {
      let result: ApiResult<PluginInfo>;
      try {
        result = await client.call(
          action === 'load' ? loadPluginEndpoint : unloadPluginEndpoint,
          id,
          combined(signal),
        );
      } catch (error) {
        try {
          await reconcile(id);
        } catch {
          /* 快照保留重查失败，原管理错误继续传递。 */
        }
        throw error;
      }
      await reconcile(id);
      return result;
    };
    const pending = queue.then(run, run);
    queue = pending.catch(() => undefined);
    return pending;
  }
  return {
    refresh,
    load: (id: string, signal: AbortSignal) => mutate(id, 'load', signal),
    unload: (id: string, signal: AbortSignal) => mutate(id, 'unload', signal),
    snapshot: resource.snapshot,
    subscribe: resource.subscribe,
    dispose() {
      closed = true;
      resource.dispose();
      lifetime.abort();
    },
  };
}
