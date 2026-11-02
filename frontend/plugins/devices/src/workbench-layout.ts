import type { UiAccess, WorkspaceLayoutNode, WorkspaceViewRef } from '@deviceforge/plugin-sdk';
import {
  DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW, DEVICE_DIRECTORY_INSTANCE_ID, DEVICE_DIRECTORY_VIEW_ID,
  DEVICE_SCREEN_INSTANCE_ID, DEVICE_SCREEN_VIEW, DEVICE_WORKBENCH_INSTANCE_ID, DEVICES_PLUGIN_ID,
  DEVICES_WORKSPACE_ID,
} from './contracts.ts';
import { deviceToolLayout } from './tool-layout.ts';
import { references } from './model.ts';

function replaceScreen(node: WorkspaceLayoutNode | null): WorkspaceLayoutNode | null {
  if (!node) return null;
  if (node.kind === 'view') return node.instanceId === DEVICE_SCREEN_INSTANCE_ID
    ? { kind: 'view', instanceId: DEVICE_WORKBENCH_INSTANCE_ID } : node;
  if (node.kind === 'custom') return node;
  if (node.kind === 'tabs') return {
    ...node, items: node.items.map((item) => ({ ...item, node: replaceScreen(item.node) ?? item.node })),
  };
  return { ...node, children: node.children.map((child) => replaceScreen(child) ?? child) };
}
function hasCustom(node: WorkspaceLayoutNode | null): boolean {
  if (!node || node.kind === 'view') return false;
  if (node.kind === 'custom') return true;
  return node.kind === 'tabs' ? node.items.some((item) => hasCustom(item.node)) : node.children.some(hasCustom);
}

/** 仅迁移旧默认三视图组合；用户明确关闭或改选提供者的布局不被静默覆盖。 */
export function migrateDeviceWorkbenchLayout(ui: UiAccess): void {
  const layout = ui.readLayout(DEVICES_WORKSPACE_ID);
  if (!layout || references(layout, DEVICE_WORKBENCH_INSTANCE_ID) || hasCustom(layout.root)) return;
  const expected: readonly [string, WorkspaceViewRef][] = [
    [DEVICE_SCREEN_INSTANCE_ID, DEVICE_SCREEN_VIEW],
    [DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW],
    [DEVICE_DIRECTORY_INSTANCE_ID, { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_DIRECTORY_VIEW_ID }],
  ];
  const instances = ui.snapshot().instances;
  for (const [instanceId, provider] of expected) {
    if (!references(layout, instanceId) ||
        [...layout.floating, ...layout.overlays].some((item) => item.instanceId === instanceId)) return;
    const current = instances.find((instance) => instance.instanceId === instanceId);
    if (current && (current.pluginId !== DEVICES_PLUGIN_ID || !current.provider ||
        current.provider.pluginId !== provider.pluginId || current.provider.viewId !== provider.viewId)) return;
  }
  const retained = deviceToolLayout(layout, new Set([DEVICE_APPS_INSTANCE_ID, DEVICE_DIRECTORY_INSTANCE_ID]), []);
  const migrated = { ...retained, root: replaceScreen(retained.root) };
  if (!references(migrated, DEVICE_WORKBENCH_INSTANCE_ID)) return;
  ui.writeLayout(DEVICES_WORKSPACE_ID, migrated);
  for (const [instanceId] of expected) {
    if (instances.some((instance) => instance.instanceId === instanceId)) ui.close(instanceId);
  }
}
