import { ApiError } from '../../../shared/api/index.ts';

export function waitForPoll(interval: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ApiError('cancelled', 'cancelled', '输出轮询等待已取消')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, interval);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new ApiError('cancelled', 'cancelled', '输出轮询等待已取消')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
