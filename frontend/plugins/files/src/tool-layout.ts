import type { WorkspaceLayout, WorkspaceLayoutNode } from '@deviceforge/plugin-sdk';

function removeOwned(node: WorkspaceLayoutNode | null, owned: ReadonlySet<string>): WorkspaceLayoutNode | null {
  if (!node) return null;
  if (!owned.size) return node;
  if (node.kind === 'view') return owned.has(node.instanceId) ? null : node;
  if (node.kind === 'tabs') {
    const items = node.items.flatMap((item) => {
      const child = removeOwned(item.node, owned);
      return child ? [{ ...item, node: child }] : [];
    });
    if (items.length === node.items.length && items.every((item, index) => item.node === node.items[index]?.node)) return node;
    if (!items.length) return null;
    if (items.length === 1) return items[0]?.node ?? null;
    return { ...node, items, active: items.some((item) => item.id === node.active) ? node.active : items[0]?.id ?? null };
  }
  const retained = (node.children ?? []).flatMap((child, index) => {
    const next = removeOwned(child, owned);
    return next ? [{ node: next, weight: node.kind === 'split' ? node.weights[index] ?? 1 : 1 }] : [];
  });
  if (retained.length === (node.children?.length ?? 0) && retained.every((item, index) => item.node === node.children?.[index])) return node;
  if (node.kind === 'custom') return { ...node, children: retained.map((item) => item.node) };
  if (!retained.length) return null;
  if (retained.length === 1) return retained[0]?.node ?? null;
  const sum = retained.reduce((total, item) => total + item.weight, 0);
  return { ...node, children: retained.map((item) => item.node), weights: retained.map((item) => item.weight / sum) };
}

/** 只增删当前消费方拥有的工具节点，原页面根、浮窗和其他插件改动继续保留。 */
export function fileToolLayout(current: WorkspaceLayout, previous: ReadonlySet<string>, ordered: readonly string[]): WorkspaceLayout {
  const base = removeOwned(current.root, previous);
  const views = ordered.map((instanceId) => ({ kind: 'view' as const, instanceId }));
  const tool: WorkspaceLayoutNode | null = views.length > 1 ? {
    kind: 'tabs', active: ordered[0] ?? null,
    items: views.map((node) => ({ id: node.instanceId, node })),
  } : views[0] ?? null;
  return { ...current, root: base && tool ? {
    kind: 'split', direction: 'horizontal', weights: [0.65, 0.35], children: [base, tool],
  } : base ?? tool,
  floating: current.floating.filter((item) => !previous.has(item.instanceId)),
  overlays: current.overlays.filter((item) => !previous.has(item.instanceId)),
  };
}
