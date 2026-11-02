import type {
  HostContext, WorkspaceLayoutNode, WorkspaceMount, WorkspaceNavigation,
} from '@deviceforge/plugin-sdk';

function includes(node: WorkspaceLayoutNode | null, id: string): boolean {
  if (!node) return false;
  if (node.kind === 'view') return node.instanceId === id;
  if (node.kind === 'tabs') return node.items.some((item) => includes(item.node, id));
  return node.children?.some((child) => includes(child, id)) ?? false;
}

/** 只在既有布局仍引用默认实例时恢复它，不覆盖用户移除或重排的布局。 */
export function registerBusinessWorkspace(context: HostContext, definition: {
  readonly pluginId: string;
  readonly title: string;
  readonly route: string;
  readonly navigation: WorkspaceNavigation;
  readonly operations: readonly string[];
  readonly provides: readonly string[];
  readonly mount: WorkspaceMount;
}): void {
  const ui = context.ui;
  if (!ui) throw new Error('此插件需要支持公开工作区的宿主');
  const prefix = definition.pluginId;
  const workspaceId = `${prefix}.workspace`, viewId = `${prefix}.main`, instanceId = `${prefix}.main.default`;
  ui.register({
    workspaces: [{
      id: workspaceId, title: `${definition.title}工作区`,
      defaultLayout: { version: 1, root: { kind: 'view', instanceId }, floating: [], overlays: [] },
    }],
    pages: [{
      id: `${prefix}.page`, title: definition.title, route: definition.route, workspaceId,
      navigation: definition.navigation, operations: definition.operations, taskPolicy: 'listed',
    }],
    views: [{ id: viewId, title: definition.title, provides: definition.provides, mount: definition.mount }],
  });
  const layout = ui.readLayout(workspaceId);
  if (layout && (includes(layout.root, instanceId) ||
      [...layout.floating, ...layout.overlays].some((item) => item.instanceId === instanceId)))
    ui.open({ instanceId, workspaceId, provider: { pluginId: prefix, viewId } }, context.signal);
}
