import { HostError } from '../plugin-sdk/index.ts';
import type { Dispose, ExtensionAccess, HostContext, HostResult } from '../plugin-sdk/index.ts';
import { scopedDeviceAccess } from './device-access.ts';
import { scopedArtifactAccess } from './artifact-access.ts';
import { scopedTaskHistoryAccess } from './task-history-access.ts';
import { scopedThemeAccess } from './theme-access.ts';

export function createPluginScope(host: HostContext) {
  const controller = new AbortController();
  const resources: Dispose[] = [];
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let closed = false;
  function track(dispose: Dispose): Dispose {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const position = resources.indexOf(release);
      if (position >= 0) resources.splice(position, 1);
      try {
        // 立即调用同步释放逻辑，异步部分汇总到 drain。
        const task = Promise.resolve(dispose()).catch((error: unknown) => { failures.push(error); });
        pending.add(task);
        void task.then(() => { pending.delete(task); });
        return task;
      } catch (error) { failures.push(error); }
    };
    if (closed) release(); else resources.push(release);
    return release;
  }
  function close() {
    if (closed) return;
    closed = true;
    controller.abort();
    for (const release of resources.splice(0).reverse()) { try { release(); } catch (error) { failures.push(error); } }
  }
  async function dispose() {
    close();
    while (pending.size) await Promise.all([...pending]);
    if (failures.length) throw new AggregateError([...failures], '插件资源释放失败');
  }
  const parentAbort = () => close();
  if (host.signal.aborted) close();
  else {
    host.signal.addEventListener('abort', parentAbort, { once: true });
    track(() => host.signal.removeEventListener('abort', parentAbort));
  }
  function current(logId: string | null = null) {
    if (closed) throw new HostError('cancelled', 'plugin_unloaded', '插件代际或面板已撤销', logId);
  }
  async function call<T>(request: (signal: AbortSignal) => Promise<HostResult<T>>, signal: AbortSignal): Promise<HostResult<T>> {
    current();
    const combined = AbortSignal.any([signal, controller.signal]);
    if (combined.aborted) throw new HostError('cancelled', 'cancelled', '等待已取消');
    const result = await request(combined);
    current(result.logId);
    if (combined.aborted) throw new HostError('cancelled', 'stale_result', '晚到结果已撤销', result.logId);
    return result;
  }
  const upstream = host.extensions;
  const extensions: ExtensionAccess | undefined = upstream ? Object.freeze<ExtensionAccess>({
    catalog: () => { current(); return upstream.catalog(); },
    executeCommand: (id, input, signal) => call((current) => upstream.executeCommand(id, input, current), signal),
    callService: (id, version, input, signal) => call((current) => upstream.callService(id, version, input, current), signal),
    subscribeEvent: (name, listener) => { current(); return track(upstream.subscribeEvent(name, (event) => { if (!closed) listener(event); })); },
    emitEvent: (name, data) => { current(); upstream.emitEvent(name, data); },
    getState: (key) => { current(); return upstream.getState(key); },
    setState: (key, value) => { current(); upstream.setState(key, value); },
    subscribeState: (key, listener) => { current(); return track(upstream.subscribeState(key, (value) => { if (!closed) listener(value); })); },
    ...(upstream.register ? { register: (value: Parameters<NonNullable<ExtensionAccess['register']>>[0]) => {
      current(); const register = upstream.register; if (!register) throw new Error('动态注册入口已撤销'); return track(register(value));
    } } : {}),
  }) : undefined;
  const devices = scopedDeviceAccess(host.devices, call, current, controller.signal, track);
  const artifacts = scopedArtifactAccess(host.artifacts, call);
  const taskHistory = scopedTaskHistoryAccess(host.taskHistory, call);
  const themes = scopedThemeAccess(host.themes, current, controller.signal, track);
  const context = Object.freeze<HostContext>({
    apiVersion: 2,
    signal: controller.signal,
    listOperations: (signal) => call((current) => host.listOperations(current), signal),
    submit: (operation, input, signal) => call((current) => host.submit(operation, input, current), signal),
    getJob: (id, signal) => call((current) => host.getJob(id, current), signal),
    cancelJob: (id, signal) => call((current) => host.cancelJob(id, current), signal),
    subscribeOperations(listener) {
      current();
      return track(host.subscribeOperations((operations) => { if (!closed) listener(operations); }));
    },
    onDispose: track,
    ...(extensions ? { extensions } : {}),
    ...(devices ? { devices } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(taskHistory ? { taskHistory } : {}),
    ...(themes ? { themes } : {}),
  });
  return { context, close, dispose, track };
}
export type PluginScope = ReturnType<typeof createPluginScope>;
