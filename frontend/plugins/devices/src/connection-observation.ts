import type { DeviceProviderInfo, Dispose, HostContext } from '@deviceforge/plugin-sdk';
import { createDeviceDirectory } from './directory.ts';
import type { DeviceDirectoryModel, DirectoryFeedback } from './directory.ts';

/** 任务完成与目录观测分开报告，重新发现失败不能改写已确认的连接结果。 */
export async function discoverAfterConnection(context: HostContext, provider: DeviceProviderInfo,
  caller: AbortSignal = context.signal): Promise<DirectoryFeedback> {
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, caller, controller.signal]);
  let directory: DeviceDirectoryModel | null = null;
  let stop: Dispose | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.throwIfAborted();
    const current = context.devices?.snapshot();
    if (!current?.providers.some((entry) => entry.id === provider.id && entry.generation === provider.generation))
      return { outcome: 'failed', message: '提供者代次已变化；未重新发现设备', logId: null };
    timer = setTimeout(() => controller.abort(new Error('目录观测超时')), 10000);
    stop = context.devices?.subscribe((snapshot) => {
      if (!snapshot.providers.some((entry) => entry.id === provider.id && entry.generation === provider.generation)) controller.abort();
    });
    directory = createDeviceDirectory({ ...context, signal });
    await directory.discover(provider);
    return directory.snapshot().feedback ?? { outcome: 'failed',
      message: '目录观测尚未确认；请稍后显式重新发现', logId: null };
  } catch (error) {
    return { outcome: 'failed', message: `目录未更新：${error instanceof Error ? error.message : '观测已停止'}`, logId: null };
  } finally { clearTimeout(timer); directory?.dispose(); void stop?.(); }
}
