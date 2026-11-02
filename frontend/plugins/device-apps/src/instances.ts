import type { HostContext, WorkspaceInstance } from '@deviceforge/plugin-sdk';
import { targetReference, deviceIdentity } from '@deviceforge/devices/model';
import { isRecord } from '@deviceforge/business-kit/api';
import { createDeviceAppsServices } from './services.ts';
import type { DeviceAppsServices } from './services.ts';

/** 以实例和代次保留模型；隐藏不释放，关闭、换目标或撤销提供者只清理该实例。 */
export function createDeviceAppsInstances(context: HostContext, pluginId: string) {
  const ui = context.ui;
  if (!ui || !context.devices || !context.artifacts)
    throw new Error('设备应用视图需要公开工作区、设备和产物能力');
  const entries = new Map<string, {
    readonly generation: number;
    readonly target: string;
    readonly services: DeviceAppsServices;
  }>();
  let disposed = false;
  function valid(instance: WorkspaceInstance) {
    return instance.provider?.pluginId === pluginId &&
      instance.provider.viewId === `${pluginId}.main` && instance.state === 'ready';
  }
  function retain(instance: WorkspaceInstance) {
    context.signal.throwIfAborted();
    if (disposed || !valid(instance)) throw new Error('设备应用视图提供者已撤销');
    const reference = targetReference(instance.target);
    if (!reference && instance.target !== null &&
        !(isRecord(instance.target) && instance.target.kind === 'device' && instance.target.reference === null))
      throw new Error('设备应用实例需要完整设备引用，不会猜测或补选目标');
    const identity = deviceIdentity(reference);
    const previous = entries.get(instance.instanceId);
    if (previous?.generation === instance.generation && previous.target === identity) return previous.services;
    if (previous) { entries.delete(instance.instanceId); previous.services.dispose(); }
    const services = createDeviceAppsServices(context, reference);
    entries.set(instance.instanceId, { generation: instance.generation, target: identity, services });
    return services;
  }
  const unsubscribe = ui.subscribe(() => {
    const current = ui.snapshot().instances;
    for (const [id, entry] of entries) {
      if (current.some((instance) => instance.instanceId === id && instance.generation === entry.generation &&
          valid(instance) && deviceIdentity(targetReference(instance.target)) === entry.target)) continue;
      entries.delete(id);
      entry.services.dispose();
    }
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', dispose);
    void unsubscribe();
    for (const entry of entries.values()) entry.services.dispose();
    entries.clear();
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  context.onDispose(dispose);
  return { retain, dispose };
}
