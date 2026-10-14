import { ApiError } from '../../../services/api/index.ts';

export function waitForAiPoll(
  interval: number,
  signal: AbortSignal,
  logId: string | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new ApiError('cancelled', 'cancelled', 'AI输出轮询等待已取消', null, logId));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, interval);
  });
}
