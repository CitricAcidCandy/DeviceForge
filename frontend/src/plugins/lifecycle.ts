import { HostError } from '../plugin-sdk/models.ts';

export interface LifecycleTimeouts {
  readonly loadMs: number;
  readonly mountMs: number;
  readonly cleanupMs: number;
}
export const defaultTimeouts: LifecycleTimeouts = { loadMs: 30_000, mountMs: 10_000, cleanupMs: 5_000 };

export function lifecycleTimeouts(value: Partial<LifecycleTimeouts> = {}): LifecycleTimeouts {
  const result = { ...defaultTimeouts, ...value };
  if (Object.values(result).some((item) => !Number.isSafeInteger(item) || item <= 0 || item > 300_000))
    throw new Error('插件生命周期预算必须为 1 至 300000 毫秒');
  return result;
}

// 只结束宿主等待。回调晚到仍被消费；携带释放函数的结果由原作用域认领。
export function awaitLifecycle<T>(
  callback: () => T | Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number,
  stage: string,
  late?: (value: T) => void | Promise<void>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      deliver();
    };
    const abort = () => finish(() => reject(new HostError('cancelled', 'plugin_unloaded', `${stage}已撤销`)));
    const timeout = () => finish(() => reject(new HostError('protocol', 'plugin_lifecycle_timeout',
      `${stage}期限已到期，回调结束及清理结果未确认`)));
    if (signal?.aborted) { abort(); return; }
    if (Date.now() >= deadline) {
      finish(() => reject(new HostError('protocol', 'plugin_lifecycle_timeout', `${stage}期限已到期`)));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(timeout, Math.max(0, deadline - Date.now()));
    Promise.resolve().then(() => {
      // 微任务真正执行前再核准，撤销后不能启动尚未进入的插件回调。
      if (settled || signal?.aborted) throw new HostError('cancelled', 'plugin_unloaded', `${stage}已撤销`);
      if (Date.now() >= deadline) throw new HostError('protocol', 'plugin_lifecycle_timeout', `${stage}期限已到期`);
      return callback();
    }).then((value) => {
      if (!settled && Date.now() >= deadline) timeout();
      if (settled) {
        if (late) void Promise.resolve().then(() => late(value)).catch(() => undefined);
      } else if (signal?.aborted) {
        abort();
        if (late) void Promise.resolve().then(() => late(value)).catch(() => undefined);
      } else finish(() => resolve(value));
    }, (error: unknown) => finish(() => reject(error)));
  });
}

export function createKeyedQueue() {
  const queues = new Map<string, Promise<unknown>>();
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const pending = (queues.get(key) ?? Promise.resolve()).then(run, run);
    const tail = pending.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return pending;
  };
}
