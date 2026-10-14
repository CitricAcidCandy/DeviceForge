import { HostError } from '../../../plugin-sdk/index.ts';

// 网关通常已支持取消；注入测试网关忽略信号时也结束等待并接住晚到拒绝。
export function awaitDeviceRequest<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new HostError('cancelled', 'cancelled', '设备请求等待已取消'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    pending.then((value) => {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) resolve(value);
    }, (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
