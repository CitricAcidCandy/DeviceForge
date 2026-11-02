import type { HostContext, WorkspaceInstance } from '@deviceforge/plugin-sdk';
import { createTerminalServices } from './services.ts';
import type { TerminalServices } from './services.ts';

/** 实例存在时保留模型与草稿；DOM 隐藏或重挂不释放，关闭或换代只撤销对应实例。 */
export function createTerminalInstances(context: HostContext, pluginId: string) {
  const ui = context.ui;
  if (!ui || !context.transport || !context.onCleanup)
    throw new Error('终端需要公开工作区、通信和有界清理能力，不会接管旧终端页面');
  const instances = new Map<string, { identity: number; services: TerminalServices }>();
  function retain(instance: WorkspaceInstance) {
    if (instance.provider?.pluginId !== pluginId || instance.state !== 'ready')
      throw new Error('终端视图提供者不可用');
    const previous = instances.get(instance.instanceId);
    if (previous?.identity === instance.generation) return previous.services;
    if (previous) {
      instances.delete(instance.instanceId);
      void previous.services.dispose().catch(() => undefined);
    }
    const services = createTerminalServices(context);
    instances.set(instance.instanceId, { identity: instance.generation, services });
    return services;
  }
  const stop = ui.subscribe(() => {
    const current = ui.snapshot().instances;
    for (const [id, entry] of instances) {
      if (current.some((instance) => instance.instanceId === id &&
          instance.generation === entry.identity && instance.provider?.pluginId === pluginId &&
          instance.state === 'ready')) continue;
      instances.delete(id);
      // 清理失败仍由该注册的 onCleanup 资源记录，不阻断其他实例或重复恢复旧写入。
      void entry.services.dispose().catch(() => undefined);
    }
  });
  context.onDispose(() => { void stop(); instances.clear(); });
  return { retain };
}
