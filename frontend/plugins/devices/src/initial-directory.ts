import type { Dispose, HostContext } from '@deviceforge/plugin-sdk';
import { beginDirectoryObservation } from './directory-observation.ts';

function wait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) { void pending.catch(() => undefined); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    pending.then((value) => {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) reject(error);
    });
  });
}
const field = (error: unknown, name: string) => {
  if (!error || typeof error !== 'object') return null;
  const value: unknown = Reflect.get(error, name);
  return typeof value === 'string' ? value : null;
};

/** 首次目录观测不阻塞页面登记，也不派发发现或设备动作。 */
export function startInitialDirectoryRead(context: HostContext, waitMs = 5000): Dispose {
  const devices = context.devices;
  if (context.signal.aborted) return () => {};
  if (!devices || devices.snapshot().providers.length) {
    beginDirectoryObservation(context, devices ? 'confirmed' : 'unavailable');
    return () => {};
  }
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 30000)
    throw new Error('首次目录读取期限须为1至30000毫秒');
  const request = new AbortController(), signal = AbortSignal.any([request.signal, context.signal]);
  const observation = beginDirectoryObservation(context);
  let closed = false, expired = false, settled = false;
  const timer = setTimeout(() => {
    expired = true;
    request.abort(new Error('首次设备目录读取超时，可从设备目录显式刷新'));
  }, waitMs);
  function dispose() {
    if (closed) return;
    closed = true;
    request.abort();
    if (!settled) observation.finish('unconfirmed');
    clearTimeout(timer);
    context.signal.removeEventListener('abort', dispose);
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  // 聚合入口自身读取提供者；不要在其后再发自动刷新，以免撤销用户后发的新读取。
  void (async () => {
    try {
      await wait(devices.refreshDirectories(signal), signal);
      observation.finish('confirmed');
    }
    catch (error) {
      if (closed || context.signal.aborted) return;
      const code = field(error, 'code');
      if (!expired && (code === 'cancelled' || code === 'stale_device_result')) {
        observation.finish('unconfirmed');
        return;
      }
      const message = error instanceof Error ? error.message : '首次设备目录读取失败，可从设备目录显式刷新';
      observation.finish('failed', message, field(error, 'logId'));
      try {
        context.debug?.emit({ name: 'devices.initial_directory.failed', metadata: {
          code: expired ? 'initial_directory_timeout' : code ?? 'initial_directory_failed',
          message,
          logId: field(error, 'logId'),
        } });
      } catch { /* 诊断入口撤销或失败不能阻断独立的手动读取。 */ }
    } finally {
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', dispose);
    }
  })();
  return dispose;
}
