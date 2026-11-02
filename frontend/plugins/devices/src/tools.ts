import type { Dispose, HostContext, UiAccess, WorkspaceViewRef } from '@deviceforge/plugin-sdk';
import { DEVICE_TOOLS_POINT, DEVICES_PLUGIN_ID, DEVICES_WORKSPACE_ID, deviceTarget, toolView } from './contracts.ts';
import { deviceToolLayout } from './tool-layout.ts';

/** 自动贡献实例属于运行代；重启只按当前贡献重建，不复活旧工具或其执行。 */
export function clearRetainedDeviceTools(ui: UiAccess): void {
  const owned = new Set(ui.snapshot().instances.filter((instance) =>
    instance.pluginId === DEVICES_PLUGIN_ID && instance.workspaceId === DEVICES_WORKSPACE_ID &&
    instance.instanceId.startsWith(`${DEVICES_PLUGIN_ID}.contribution.`)).map((instance) => instance.instanceId));
  if (!owned.size) return;
  const layout = ui.readLayout(DEVICES_WORKSPACE_ID);
  if (layout) ui.writeLayout(DEVICES_WORKSPACE_ID, deviceToolLayout(layout, owned, []));
  for (const instanceId of owned) ui.close(instanceId);
}

/** 插件贡献激活即参与工作区，撤销时移除自有实例，不要求用户点“添加”。 */
export function synchronizeDeviceTools(context: HostContext): Dispose {
  const ui = context.ui, points = context.extensions?.points;
  if (!ui || !points) return () => {};
  const bindings = new Map<string, { instanceId: string; provider: WorkspaceViewRef }>();
  let sequence = 0, closed = false, updating = false;
  function refresh() {
    if (closed || updating || context.signal.aborted || !ui || !points) return;
    updating = true;
    const opened: string[] = [];
    try {
      const entries = points.list(DEVICE_TOOLS_POINT).flatMap((entry) => {
        const provider = toolView(entry.data);
        return entry.state === 'active' && entry.mode === 'append' && provider
          ? [{ key: JSON.stringify([entry.provider.pluginId, entry.provider.generation, entry.id, provider]), provider }]
          : [];
      });
      const previous = new Set([...bindings.values()].map((binding) => binding.instanceId));
      const active = new Set(entries.map((entry) => entry.key));
      const instances = new Set(ui.snapshot().instances.map((instance) => instance.instanceId));
      for (const entry of entries) {
        if (bindings.has(entry.key)) continue;
        let instanceId: string;
        do { instanceId = `${DEVICES_PLUGIN_ID}.contribution.${++sequence}`; } while (instances.has(instanceId));
        try {
          ui.open({
            instanceId, workspaceId: DEVICES_WORKSPACE_ID, provider: entry.provider,
            target: deviceTarget(context.devices?.snapshot().selection ?? null), visible: false,
          }, context.signal);
        } catch (error) {
          context.extensions?.emitEvent('deviceforge_devices.tools.failed', {
            contribution: entry.key,
            message: error instanceof Error ? error.message : '插件工具实例未能建立',
          });
          continue;
        }
        opened.push(instanceId);
        bindings.set(entry.key, { instanceId, provider: entry.provider });
      }
      const current = ui.readLayout(DEVICES_WORKSPACE_ID);
      if (current) {
        const ordered = entries.flatMap((entry) => {
          const binding = bindings.get(entry.key);
          return binding ? [binding.instanceId] : [];
        });
        const next = deviceToolLayout(current, previous, ordered);
        if (JSON.stringify(next) !== JSON.stringify(current)) ui.writeLayout(DEVICES_WORKSPACE_ID, next);
      }
      for (const [key, binding] of bindings) {
        if (active.has(key)) continue;
        bindings.delete(key);
        ui.close(binding.instanceId);
      }
    } catch (error) {
      for (const [key, binding] of bindings) {
        if (!opened.includes(binding.instanceId)) continue;
        bindings.delete(key);
        try { ui.close(binding.instanceId); } catch { /* 已撤销的实例由所属作用域继续释放。 */ }
      }
      context.extensions?.emitEvent('deviceforge_devices.tools.failed', {
        message: error instanceof Error ? error.message : '设备插件工具未能装配',
      });
    } finally { updating = false; }
  }
  const release = points.subscribe(refresh);
  refresh();
  return () => {
    if (closed) return;
    closed = true;
    void release();
    if (context.signal.aborted || !ui) return;
    const owned = new Set([...bindings.values()].map((binding) => binding.instanceId));
    const layout = ui.readLayout(DEVICES_WORKSPACE_ID);
    if (layout) ui.writeLayout(DEVICES_WORKSPACE_ID, deviceToolLayout(layout, owned, []));
    for (const instanceId of owned) ui.close(instanceId);
    bindings.clear();
  };
}
