import type { JobDto } from '../../services/api/index.ts';
import type { ProductRoute } from './route-address.ts';

export const taskStateLabels: Readonly<Record<JobDto['status'], string>> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

export interface TaskRouteContribution {
  readonly key: ProductRoute;
  readonly operations?: readonly string[];
  readonly taskPolicy?: 'listed' | 'all';
}

/** 归属只消费当代页面贡献；旧设备能力集合仍允许调用方显式注入。 */
export function taskBelongsToRoute(
  operation: string,
  route: ProductRoute,
  deviceOperations?: ReadonlySet<string>,
  routes: readonly TaskRouteContribution[] = [],
): boolean {
  if (route === 'devices' && deviceOperations?.has(operation)) return true;
  return routes.some((entry) => entry.key === route &&
    (entry.taskPolicy === 'all' || entry.operations?.includes(operation)));
}

/** 从最新目录读取，插件卸载或代次变化无需重建匹配器。 */
export function createTaskRouteMatcher(source: () => readonly TaskRouteContribution[]) {
  return (operation: string, route: ProductRoute, deviceOperations?: ReadonlySet<string>): boolean =>
    taskBelongsToRoute(operation, route, deviceOperations, source());
}
