import type { WorkspaceLayout, WorkspaceLayoutNode } from '@deviceforge/plugin-sdk';

function without(node: WorkspaceLayoutNode | null, removed: ReadonlySet<string>): WorkspaceLayoutNode | null {
  if (!node) return null;
  if (node.kind === 'view') return removed.has(node.instanceId) ? null : node;
  if (node.kind === 'tabs') {
    const items = node.items.flatMap((item) => {
      const child = without(item.node, removed);
      return child ? [{ ...item, node: child }] : [];
    });
    const active = items.find((item) => item.id === node.active) ?? items[0];
    return active ? { ...node, items, active: active.id } : null;
  }
  if (node.kind === 'custom') {
    if (!node.children) return node;
    return { ...node, children: node.children.flatMap((child) => {
      const next = without(child, removed);
      return next ? [next] : [];
    }) };
  }
  const retained = node.children.flatMap((child, index) => {
    const next = without(child, removed);
    return next ? [{ node: next, weight: node.weights[index] ?? 1 }] : [];
  });
  if (retained.length < 2) return retained[0]?.node ?? null;
  const total = retained.reduce((sum, item) => sum + item.weight, 0);
  return { ...node, children: retained.map((item) => item.node), weights: retained.map((item) => item.weight / total) };
}

/** 只移动本消费者拥有的工具实例，不覆盖其他插件已经提供的内容与草稿。 */
export function deviceToolLayout(layout: WorkspaceLayout, previous: ReadonlySet<string>, ordered: readonly string[]): WorkspaceLayout {
  let root = without(layout.root, previous);
  for (const instanceId of ordered) {
    const view: WorkspaceLayoutNode = { kind: 'view', instanceId };
    root = root ? { kind: 'split', direction: 'horizontal', weights: [0.7, 0.3], children: [root, view] } : view;
  }
  return {
    ...layout, root,
    floating: layout.floating.filter((view) => !previous.has(view.instanceId)),
    overlays: layout.overlays.filter((view) => !previous.has(view.instanceId)),
  };
}
