import type { WorkspaceLayout, WorkspaceLayoutNode } from '@deviceforge/plugin-sdk';

function contains(node: WorkspaceLayoutNode | null, instanceId: string): boolean {
  if (!node) return false;
  if (node.kind === 'view') return node.instanceId === instanceId;
  if (node.kind === 'tabs') return node.items.some((item) => contains(item.node, instanceId));
  return node.children?.some((child) => contains(child, instanceId)) ?? false;
}
export function appendViewLayout(original: WorkspaceLayout, instanceId: string): WorkspaceLayout {
  if (contains(original.root, instanceId) ||
      [...original.floating, ...original.overlays].some((item) => item.instanceId === instanceId))
    throw new Error('所选实例已在布局中，不会重复追加');
  const next = structuredClone(original), view: WorkspaceLayoutNode = { kind: 'view', instanceId };
  return {
    ...next,
    root: next.root ? {
      kind: 'tabs', active: 'workspace-example',
      items: [
        { id: 'original-workspace', title: '原工作区', node: next.root },
        { id: 'workspace-example', title: '组合示例', node: view },
      ],
    } : view,
  };
}
