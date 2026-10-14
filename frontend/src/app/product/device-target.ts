import type { ProductServices } from './services.ts';
import type { DeviceRef } from '../../plugin-sdk/index.ts';
import { ApiError } from '../../services/api/index.ts';

// 旧独立插件只接收本地设备 ID；产品组合层仍绑定完整引用并撤销换代后的等待。
export async function withSelectedDevice<T>(services: ProductServices, signal: AbortSignal, run: (reference: DeviceRef, active: AbortSignal) => Promise<T>) {
  const devices = services.runtime.devices;
  const initial = devices.snapshot();
  const reference = initial.selection;
  if (!reference || initial.selected?.state !== 'online') throw new Error('请先选择在线设备');
  if (signal.aborted || services.runtime.host.signal.aborted) throw new ApiError('cancelled', 'cancelled', '设备等待已取消');
  const identity = JSON.stringify(reference);
  const capabilities = JSON.stringify(initial.selected.capabilities);
  const changed = new AbortController();
  const unsubscribe = devices.subscribe(next => {
    if (JSON.stringify(next.selection) !== identity || next.selected?.state !== 'online' || JSON.stringify(next.selected.capabilities) !== capabilities) changed.abort();
  });
  const active = AbortSignal.any([signal, changed.signal, services.runtime.host.signal]);
  try {
    const result = await run(reference, active);
    if (active.aborted) {
      const logId = result !== null && typeof result === 'object' && 'logId' in result && typeof result.logId === 'string' ? result.logId : null;
      throw new ApiError('cancelled', 'stale_device_result', '设备已切换、能力已撤销或提供者已换代，请重新查询原任务', null, logId);
    }
    return result;
  } finally { unsubscribe(); }
}
