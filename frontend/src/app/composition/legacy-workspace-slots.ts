import type {
  WorkspaceInstance, WorkspaceLayoutNode, WorkspacePageInfo, WorkspaceSnapshot, WorkspaceViewInfo,
} from '../../plugin-sdk/index.ts';

function directViews(node: WorkspaceLayoutNode | null): readonly string[] {
  if (!node || node.kind === 'custom') return [];
  if (node.kind === 'view') return [node.instanceId];
  if (node.kind === 'tabs') return node.items.flatMap((item) => directViews(item.node));
  return node.children.flatMap(directViews);
}

/** 仅适配页面所有者在主布局中的唯一业务视图，不包装子实例或穿透自定义布局。 */
export function legacyWorkspacePage(
  instance: WorkspaceInstance, snapshot: WorkspaceSnapshot,
): WorkspacePageInfo | null {
  const provider = instance.provider;
  if (!provider || instance.state !== 'ready') return null;
  const pages = snapshot.catalog.pages.filter((page) => page.workspaceId === instance.workspaceId &&
    page.pluginId === provider.pluginId && page.generation === instance.providerGeneration);
  const page = pages.length === 1 ? pages[0] : undefined;
  if (!page || !snapshot.catalog.workspaces.some((workspace) => workspace.id === instance.workspaceId &&
      workspace.pluginId === page.pluginId && workspace.generation === page.generation)) return null;
  const layout = snapshot.layouts.find((entry) => entry.workspaceId === instance.workspaceId)?.layout;
  const roots = new Set(directViews(layout?.root ?? null));
  const candidates = snapshot.instances.filter((entry) => roots.has(entry.instanceId) && entry.state === 'ready' &&
    entry.workspaceId === instance.workspaceId && entry.provider?.pluginId === page.pluginId &&
    entry.providerGeneration === page.generation);
  return candidates.length === 1 && candidates[0]?.instanceId === instance.instanceId ? page : null;
}

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
