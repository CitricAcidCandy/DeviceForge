import type {
  DeviceAccess, DeviceProviderInfo, DeviceRef, DeviceSnapshot, Dispose, HostContext, HostResult,
} from '@deviceforge/plugin-sdk';
import { deviceIdentity } from './contracts.ts';

export interface DirectoryFeedback {
  readonly outcome: 'completed' | 'failed';
  readonly message: string;
  readonly logId: string | null;
}
export interface DirectoryState {
  readonly devices: DeviceSnapshot;
  readonly pending: string | null;
  readonly feedback: DirectoryFeedback | null;
}
function logId(value: unknown): string | null {
  return value && typeof value === 'object' && 'logId' in value && typeof value.logId === 'string'
    ? value.logId : null;
}
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
function requireDevices(devices: DeviceAccess | undefined): DeviceAccess {
  if (!devices) throw new Error('当前宿主没有提供设备目录能力');
  return devices;
}

/** 目录只调用公开设备入口；切换目标与销毁后，旧回执不得覆盖当前提示。 */
export function createDeviceDirectory(context: HostContext) {
  const devices = requireDevices(context.devices);
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let active: AbortController | null = null, closed = false;
  let selected = deviceIdentity(devices.snapshot().selection);
  let state: DirectoryState = { devices: devices.snapshot(), pending: null, feedback: null };
  const publish = (change: Partial<DirectoryState>) => {
    if (closed || context.signal.aborted) return;
    state = Object.freeze({ ...state, ...change });
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个界面订阅失败不能阻断目录更新或下一次独立请求。 */ }
    }
  };
  const stop = devices.subscribe((snapshot) => {
    const next = deviceIdentity(snapshot.selection);
    if (selected !== next) {
      selected = next;
      active?.abort();
      active = null;
      publish({ devices: snapshot, pending: null, feedback: null });
    } else publish({ devices: snapshot });
  });
  async function run<T>(label: string, work: (signal: AbortSignal) => Promise<HostResult<T>>) {
    if (closed || context.signal.aborted) throw new Error('设备目录已经关闭');
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const signal = AbortSignal.any([controller.signal, lifetime.signal, context.signal]);
    publish({ pending: label, feedback: null });
    try {
      const result = await wait(work(signal), signal);
      if (active !== controller || signal.aborted) return;
      publish({
        devices: devices.snapshot(), pending: null,
        feedback: { outcome: 'completed', message: `${label}已完成`, logId: result.logId },
      });
    } catch (error) {
      if (active !== controller || signal.aborted) return;
      publish({
        pending: null,
        feedback: { outcome: 'failed', message: error instanceof Error ? error.message : '设备目录调用失败', logId: logId(error) },
      });
    } finally { if (active === controller) active = null; }
  }
  const dispose: Dispose = () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    active?.abort();
    active = null;
    void stop();
    listeners.clear();
  };
  context.signal.addEventListener('abort', dispose, { once: true });
  return {
    snapshot: (): DirectoryState => state,
    subscribe(listener: () => void): Dispose { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(reference: DeviceRef | null) { if (!closed) devices.select(reference); },
    refresh: () => run('读取设备目录', async (signal) => {
      await devices.refreshProviders(signal);
      signal.throwIfAborted();
      return devices.refreshDirectories(signal);
    }),
    discover: (provider: DeviceProviderInfo) =>
      run('发现设备', (signal) => devices.refreshProvider(provider.id, provider.generation, signal)),
    cancel() { active?.abort(); active = null; publish({ pending: null }); },
    dispose() { context.signal.removeEventListener('abort', dispose); return dispose(); },
  };
}
export type DeviceDirectoryModel = ReturnType<typeof createDeviceDirectory>;
