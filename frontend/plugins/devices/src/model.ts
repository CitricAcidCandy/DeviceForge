import type {
  Dispose, HostContext, UiAccess, WorkspaceLayout, WorkspaceLayoutNode, WorkspaceViewRef,
} from '@deviceforge/plugin-sdk';
import {
  acceptsDeviceTarget, DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW,
  DEVICE_DIRECTORY_INSTANCE_ID, DEVICE_DIRECTORY_VIEW_ID, DEVICE_SCREEN_INSTANCE_ID,
  DEVICE_SCREEN_VIEW, DEVICES_PLUGIN_ID, DEVICES_WORKSPACE_ID, deviceTarget,
  LEGACY_DEVICE_APPS_VIEW, DEVICE_WORKBENCH_INSTANCE_ID, DEVICE_WORKBENCH_VIEW_ID, updateDeviceReference,
} from './contracts.ts';

export * from './contracts.ts';

function includes(node: WorkspaceLayoutNode | null, instanceId: string): boolean {
  if (!node) return false;
  if (node.kind === 'view') return node.instanceId === instanceId;
  if (node.kind === 'split') return node.children.some((child) => includes(child, instanceId));
  if (node.kind === 'tabs') return node.items.some((item) => includes(item.node, instanceId));
  return node.children?.some((child) => includes(child, instanceId)) ?? false;
}
export function references(layout: WorkspaceLayout | null, instanceId: string): boolean {
  return Boolean(layout && (includes(layout.root, instanceId) ||
    [...layout.floating, ...layout.overlays].some((item) => item.instanceId === instanceId)));
}

/** 只迁移已退役应用桥的精确引用，保留布局、目标及用户选择的其他提供者。 */
export function migrateDeviceAppProvider(ui: UiAccess): void {
  for (const instance of ui.snapshot().instances) {
    if (instance.provider?.pluginId === LEGACY_DEVICE_APPS_VIEW.pluginId &&
        instance.provider.viewId === LEGACY_DEVICE_APPS_VIEW.viewId)
      ui.selectProvider(instance.instanceId, DEVICE_APPS_VIEW);
  }
}

/** 只认领保留在布局中的自有实例，不自动恢复已关闭视图或旧业务执行。 */
export function restoreDeviceInstances(context: HostContext, ui: UiAccess): void {
  const layout = ui.readLayout(DEVICES_WORKSPACE_ID);
  const defaults: readonly [string, WorkspaceViewRef][] = [
    [DEVICE_WORKBENCH_INSTANCE_ID, { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_WORKBENCH_VIEW_ID }],
    [DEVICE_SCREEN_INSTANCE_ID, DEVICE_SCREEN_VIEW],
    [DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW],
    [DEVICE_DIRECTORY_INSTANCE_ID, { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_DIRECTORY_VIEW_ID }],
  ];
  const existing = ui.snapshot().instances;
  const candidates: readonly [string, WorkspaceViewRef | null][] = [
    ...defaults,
    ...existing.filter((instance) => instance.pluginId === DEVICES_PLUGIN_ID &&
      instance.workspaceId === DEVICES_WORKSPACE_ID &&
      !defaults.some(([id]) => id === instance.instanceId))
      .map((instance): [string, WorkspaceViewRef | null] => [instance.instanceId, instance.provider]),
  ];
  for (const [instanceId, provider] of candidates) {
    if (!references(layout, instanceId)) continue;
    const retained = existing.find((entry) => entry.instanceId === instanceId);
    if (retained && retained.reason !== 'owner_inactive') continue;
    ui.open({
      instanceId, workspaceId: DEVICES_WORKSPACE_ID, provider: retained ? retained.provider : provider,
      target: !retained || acceptsDeviceTarget(retained.target)
        ? updateDeviceReference(retained?.target ?? null, context.devices?.snapshot().selection ?? null) : retained.target,
      visible: retained?.visible ?? false,
    }, context.signal);
  }
}

/** 新加入且未指定目标的视图继承设备；显式的非设备目标不由组合层覆盖。 */
export function synchronizeDeviceTargets(context: HostContext, ui: UiAccess): Dispose {
  const devices = context.devices;
  if (!devices) return () => {};
  let updating = false, closed = false;
  const synchronize = () => {
    if (closed || updating || context.signal.aborted) return;
    updating = true;
    try {
      const reference = devices.snapshot().selection;
      for (const instance of ui.snapshot().instances) {
        if (instance.workspaceId !== DEVICES_WORKSPACE_ID || instance.reason === 'owner_inactive' ||
            !acceptsDeviceTarget(instance.target)) continue;
        const target = updateDeviceReference(instance.target, reference);
        if (JSON.stringify(instance.target) === JSON.stringify(target)) continue;
        // 父视图换代会同步撤销所属子实例，不能继续操作旧快照中的已撤销子项。
        if (!ui.snapshot().instances.some((current) => current.instanceId === instance.instanceId &&
            current.generation === instance.generation && current.reason !== 'owner_inactive')) continue;
        ui.setTarget(instance.instanceId, target);
      }
    } finally { updating = false; }
  };
  const stopDevices = devices.subscribe(synchronize);
  const stopUi = ui.subscribe(synchronize);
  synchronize();
  return () => {
    if (closed) return;
    closed = true;
    void stopUi();
    void stopDevices();
  };
}

export function addDeviceTool(context: HostContext, provider: WorkspaceViewRef): string {
  const ui = context.ui;
  if (!ui) throw new Error('当前宿主没有工作区能力');
  const layout = ui.readLayout(DEVICES_WORKSPACE_ID) ?? { version: 1, root: null, floating: [], overlays: [] };
  const ids = new Set(ui.snapshot().instances.map((instance) => instance.instanceId));
  let next = 1;
  while (ids.has(`${DEVICES_PLUGIN_ID}.tool.${next}`)) next++;
  const instanceId = `${DEVICES_PLUGIN_ID}.tool.${next}`;
  ui.open({
    instanceId, workspaceId: DEVICES_WORKSPACE_ID, provider,
    target: deviceTarget(context.devices?.snapshot().selection ?? null),
  }, context.signal);
  try {
    ui.writeLayout(DEVICES_WORKSPACE_ID, {
      ...layout,
      root: layout.root ? {
        kind: 'split', direction: 'horizontal', weights: [0.65, 0.35],
        children: [layout.root, { kind: 'view', instanceId }],
      } : { kind: 'view', instanceId },
    });
  } catch (error) {
    ui.close(instanceId);
    throw error;
  }
  return instanceId;
}
