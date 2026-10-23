import { ApiError } from '../../../services/api/index.ts';
import type { DeviceAccess } from '../../../plugin-sdk/index.ts';

// 全量发现按提供者串行，避免超过服务器发现队列；单个失败不吞掉其他提供者。
// 选择页与顶栏胶囊共用这一份：两处都点「发现设备」，行为必须一致。
export async function discoverProviders(
  devices: DeviceAccess,
  signal: AbortSignal,
): Promise<{
  data: { discovered: number; failures: { provider: string; message: string; logId: string | null }[] };
  logId: string | null;
}> {
  const listed = await devices.refreshProviders(signal);
  const failures: { provider: string; message: string; logId: string | null }[] = [];
  let discovered = 0;
  let logId = listed.logId;
  for (const provider of listed.data) {
    if (signal.aborted)
      throw new ApiError('cancelled', 'cancelled', '设备发现等待已取消', null, logId);
    try {
      const result = await devices.refreshProvider(provider.id, provider.generation, signal);
      discovered += 1;
      logId = result.logId ?? logId;
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push({
        provider: provider.id,
        message: error instanceof Error ? error.message : '发现失败，请重新查询',
        logId:
          error !== null &&
          typeof error === 'object' &&
          'logId' in error &&
          typeof error.logId === 'string'
            ? error.logId
            : null,
      });
    }
  }
  return {
    data: { discovered, failures },
    // 汇总失败只关联失败请求，成功目录查询不能冒充发现失败日志。
    logId: failures.length ? (failures.find((failure) => failure.logId)?.logId ?? null) : logId,
  };
}
