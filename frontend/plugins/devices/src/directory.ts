import type {
  DeviceAccess, DeviceProviderInfo, DeviceRef, DeviceSnapshot, Dispose, HostContext, HostResult, Operation,
} from '@deviceforge/plugin-sdk';
import { deviceIdentity } from './contracts.ts';
import { beginDirectoryObservation } from './directory-observation.ts';

export interface DirectoryFeedback {
  readonly outcome: 'completed' | 'partial' | 'failed';
  readonly message: string;
  readonly logId: string | null;
  readonly details?: readonly { readonly provider: string; readonly message: string; readonly logId: string | null }[];
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
  if (signal.aborted) { void promise.catch(() => undefined); throw signal.reason; }
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
export function createDeviceDirectory(context: HostContext, timeoutMs = 30000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error('目录等待期限须为1至30000毫秒');
  const devices = requireDevices(context.devices);
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let active: AbortController | null = null, closed = false;
  let selected = deviceIdentity(devices.snapshot().selection);
  let state: DirectoryState = { devices: devices.snapshot(), pending: null, feedback: null };
  const operationTitles = new Map<string, string>();
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
  const observeOperations = (operations: readonly Operation[]) => {
    if (closed || context.signal.aborted) return;
    operationTitles.clear();
    for (const operation of operations) operationTitles.set(operation.id, operation.title);
    publish({});
  };
  const stopOperations = context.subscribeOperations(observeOperations);
  const operationRead = new AbortController();
  const operationSignal = AbortSignal.any([operationRead.signal, lifetime.signal, context.signal]);
  const operationTimer = setTimeout(() => operationRead.abort(), 5000);
  // 中文能力名只读取得；它慢或失败都不阻塞选择页与设备操作。
  void wait(Promise.resolve().then(() => context.listOperations(operationSignal)), operationSignal)
    .then((result) => observeOperations(result.data), () => undefined)
    .finally(() => clearTimeout(operationTimer));
  async function run<T>(label: string, work: (signal: AbortSignal) => Promise<HostResult<T>>,
    feedback?: (result: HostResult<T>) => DirectoryFeedback, readsDirectory = false) {
    if (closed || context.signal.aborted) throw new Error('设备目录已经关闭');
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const observation = readsDirectory ? beginDirectoryObservation(context) : null;
    const signal = AbortSignal.any([controller.signal, lifetime.signal, context.signal]);
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
    publish({ pending: label, feedback: null });
    try {
      const result = await wait(work(signal), signal);
      if (active !== controller || signal.aborted) return;
      observation?.finish('confirmed');
      publish({
        devices: devices.snapshot(), pending: null,
        feedback: feedback?.(result) ?? { outcome: 'completed', message: `${label}已完成`, logId: result.logId },
      });
    } catch (error) {
      if (active !== controller || lifetime.signal.aborted || context.signal.aborted || signal.aborted && !expired) return;
      const message = expired ? `${label}等待超时，结果未确认；可重新读取目录核对`
        : error instanceof Error ? error.message : '设备目录调用失败';
      observation?.finish('failed', message, logId(error));
      publish({
        pending: null,
        feedback: { outcome: 'failed', message, logId: logId(error) },
      });
    } finally {
      clearTimeout(timer);
      if (signal.aborted && !expired) observation?.finish('unconfirmed');
      if (active === controller) active = null;
    }
  }
  const dispose: Dispose = () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    active?.abort();
    active = null;
    void stop();
    void stopOperations();
    operationRead.abort();
    clearTimeout(operationTimer);
    listeners.clear();
  };
  context.signal.addEventListener('abort', dispose, { once: true });
  return {
    snapshot: (): DirectoryState => state,
    subscribe(listener: () => void): Dispose { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(reference: DeviceRef | null) { if (!closed) devices.select(reference); },
    // 聚合入口已经读取提供者，不能在这里再读一次并撤销它拥有的观测。
    refresh: () => run('读取设备目录', (signal) => devices.refreshDirectories(signal), undefined, true),
    discover: (provider: DeviceProviderInfo) =>
      run('发现设备', (signal) => devices.refreshProvider(provider.id, provider.generation, signal)),
    discoverAll: () => run('发现设备', async (signal) => {
      const listed = await wait(devices.refreshProviders(signal), signal);
      const failures: { provider: string; message: string; logId: string | null }[] = [];
      let discovered = 0, lastLogId = listed.logId;
      for (const provider of listed.data) {
        signal.throwIfAborted();
        try {
          const result = await wait(devices.refreshProvider(provider.id, provider.generation, signal), signal);
          discovered++;
          lastLogId = result.logId ?? lastLogId;
        } catch (error) {
          signal.throwIfAborted();
          failures.push({ provider: provider.id, message: error instanceof Error ? error.message : '提供者发现失败', logId: logId(error) });
        }
      }
      return { data: { discovered, failures }, logId: failures.find((failure) => failure.logId)?.logId ?? lastLogId };
    }, ({ data, logId: resultLogId }) => ({
      outcome: data.failures.length ? data.discovered ? 'partial' : 'failed' : 'completed',
      message: data.failures.length ? `已完成 ${data.discovered} 个提供者的发现，${data.failures.length} 个失败`
        : data.discovered ? `设备发现已完成：${data.discovered} 个提供者` : '暂无运行中的设备提供者',
      logId: resultLogId, details: data.failures,
    }), true),
    titleOf: (operation: string) => operationTitles.get(operation) ?? operation,
    cancel() { active?.abort(); active = null; publish({ pending: null }); },
    dispose() { context.signal.removeEventListener('abort', dispose); return dispose(); },
  };
}
export type DeviceDirectoryModel = ReturnType<typeof createDeviceDirectory>;
