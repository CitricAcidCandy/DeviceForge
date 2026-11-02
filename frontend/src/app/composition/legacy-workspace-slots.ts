import type { WorkspaceInstance, WorkspaceViewInfo } from '../../plugin-sdk/index.ts';

/** 旧应用槽位只属于原主实例，额外独立实例不争用同一个旧挂载点。 */
export function legacyWorkspaceSlot(
  instance: WorkspaceInstance, views: readonly WorkspaceViewInfo[],
): string | null {
  if (instance.instanceId !== 'deviceforge_devices.apps.main' || !instance.provider) return null;
  const provider = instance.provider;
  const view = views.find((entry) => entry.pluginId === provider.pluginId && entry.id === provider.viewId &&
    entry.generation === instance.providerGeneration);
  return view?.provides.includes('device.apps') ? 'devices.apps' : null;
}
