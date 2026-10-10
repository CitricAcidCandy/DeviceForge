import type { Devices } from '../features/devices/index.ts';

// 本实例管理收敛时先撤销操作目录及目标提供者缓存，再按公开查询重查。
export function createCatalogRefresh(refreshOperations: (signal: AbortSignal) => Promise<unknown>, devices: Devices, invalidateOperations: () => void) {
  return async (signal: AbortSignal, id: string) => {
    invalidateOperations();
    devices.invalidateProvider(id);
    const results = await Promise.allSettled([refreshOperations(signal), devices.refreshDirectories(signal)]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '本地管理后的公开目录重查失败');
  };
}
