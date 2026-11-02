import type { DeviceAccess, DeviceSnapshot, Dispose, HostContext } from '@deviceforge/plugin-sdk';
import { deviceIdentity } from './contracts.ts';

export interface HeaderFailure { readonly provider: string; readonly message: string; readonly logId: string | null }
export interface DeviceHeaderState {
  readonly devices: DeviceSnapshot;
  readonly pending: boolean;
  readonly feedback: {
    readonly outcome: 'completed' | 'partial' | 'failed' | 'cancelled';
    readonly message: string;
    readonly logId: string | null;
    readonly details: readonly HeaderFailure[];
  } | null;
}
const errorLog = (error: unknown): string | null => error !== null && typeof error === 'object' &&
  'logId' in error && typeof error.logId === 'string' ? error.logId : null;

/** 发现只结束本地等待；不会把取消回执当成服务器任务已停止。 */
function wait<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(
      (value) => { signal.removeEventListener('abort', aborted); if (!signal.aborted) resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
}

/** 顶栏只消费设备公开上下文；不创建宿主业务工厂，不自动发现或选择设备。 */
export function createDeviceHeader(context: HostContext, options: { readonly waitMs?: number } = {}) {
  if (!context.devices) throw new Error('设备顶栏需要公开设备目录能力');
  const devices: DeviceAccess = context.devices;
  const waitMs = options.waitMs ?? 30_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 300_000) throw new Error('设备发现等待期限无效');
  const listeners = new Set<() => void>();
  let state: DeviceHeaderState = { devices: devices.snapshot(), pending: false, feedback: null };
  let closed = false, active: AbortController | null = null;
  let pending: Promise<void> | null = null;
  function publish(change: Partial<DeviceHeaderState>) {
    if (closed || context.signal.aborted) return;
    state = Object.freeze({ ...state, ...change });
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个视图订阅不妨碍其他视图或独立操作。 */ }
    }
  }
  const releaseDevices = devices.subscribe((snapshot) => publish({ devices: snapshot }));
  function select(key: string | null): boolean {
    if (closed || context.signal.aborted) return false;
    if (key === null) { devices.select(null); return true; }
    const snapshot = devices.snapshot();
    const device = snapshot.directories.flatMap((entry) => entry.devices)
      .find((entry) => deviceIdentity(entry.reference) === key &&
        snapshot.providers.some((provider) => provider.id === entry.reference.providerId &&
          provider.generation === entry.reference.generation));
    if (!device) {
      publish({ feedback: { outcome: 'failed', message: '设备目录已变化，请重新选择设备', logId: null, details: [] } });
      return false;
    }
    devices.select(device.reference);
    return true;
  }
  function discover(): Promise<void> {
    if (closed || context.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, context.signal]);
    const timeout = new Error('设备发现等待超时，结果尚未确认，请重新读取目录');
    const timer = setTimeout(() => controller.abort(timeout), waitMs);
    active = controller;
    const current = () => !closed && !context.signal.aborted && active === controller;
    const task = Promise.resolve().then(async () => {
      try {
        const listed = await wait(() => devices.refreshProviders(signal), signal);
        const failures: HeaderFailure[] = [];
        let discovered = 0, logId = listed.logId;
        // 沿用原串行发现，避免超出服务器发现队列；单项失败继续下一提供者。
        for (const provider of listed.data) {
          try {
            const result = await wait(() => devices.refreshProvider(provider.id, provider.generation, signal), signal);
            discovered++;
            logId = result.logId ?? logId;
          } catch (error) {
            if (signal.aborted) throw error;
            failures.push({ provider: provider.id, message: error instanceof Error ? error.message : '发现结果未确认', logId: errorLog(error) });
          }
        }
        if (!current() || signal.aborted) return;
        publish({ pending: false, devices: devices.snapshot(), feedback: {
          outcome: failures.length ? discovered ? 'partial' : 'failed' : 'completed',
          message: failures.length ? `已刷新 ${discovered} 个提供者，${failures.length} 个发现失败`
            : listed.data.length ? `已刷新 ${discovered} 个提供者的设备目录` : '暂无运行中的设备提供者',
          logId: failures.length ? failures.find((failure) => failure.logId)?.logId ?? null : logId,
          details: failures,
        } });
      } catch (error) {
        if (current()) publish({ pending: false, feedback: {
          outcome: 'failed', message: error instanceof Error ? error.message : '设备发现结果未确认',
          logId: errorLog(error), details: [],
        } });
      } finally {
        clearTimeout(timer);
        if (active === controller) { active = null; pending = null; }
      }
    });
    pending = task;
    publish({ pending: true, feedback: null });
    return task;
  }
  function cancel() {
    const operation = active;
    if (!operation) return;
    active = null;
    pending = null;
    operation.abort(new Error('设备发现等待已取消'));
    publish({ pending: false, feedback: {
      outcome: 'cancelled', message: '已取消本次等待；发现可能仍在执行，请重新读取目录确认', logId: null, details: [],
    } });
  }
  function dispose() {
    if (closed) return;
    closed = true;
    context.signal.removeEventListener('abort', dispose);
    active?.abort(new Error('设备顶栏已撤销'));
    active = null; pending = null;
    void releaseDevices();
    listeners.clear();
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();
  return {
    snapshot: () => state,
    subscribe(listener: () => void): Dispose { if (closed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    select, discover, cancel, dispose,
  };
}
export type DeviceHeaderModel = ReturnType<typeof createDeviceHeader>;
