import type {
  JsonValue, WorkspaceLayout, WorkspaceLayoutNode, WorkspaceFloatingView,
} from '@deviceforge/plugin-sdk';

export type Placement = 'split' | 'tabs' | 'floating' | 'overlay';
export const emptyLayout = (): WorkspaceLayout => ({ version: 1, root: null, floating: [], overlays: [] });
export function instancesIn(node: WorkspaceLayoutNode | null): readonly string[] {
  if (!node) return [];
  if (node.kind === 'view') return [node.instanceId];
  if (node.kind === 'tabs') return node.items.flatMap((item) => instancesIn(item.node));
  return (node.children ?? []).flatMap(instancesIn);
}
export function visibleInstances(layout: WorkspaceLayout): ReadonlySet<string> {
  const result = new Set<string>();
  const visit = (node: WorkspaceLayoutNode | null) => {
    if (!node) return;
    if (node.kind === 'view') result.add(node.instanceId);
    else if (node.kind === 'tabs') {
      const selected = node.items.find((item) => item.id === node.active) ?? node.items[0];
      if (selected) visit(selected.node);
    } else for (const child of node.children ?? []) visit(child);
  };
  visit(layout.root);
  for (const view of [...layout.floating, ...layout.overlays]) result.add(view.instanceId);
  return result;
}
function transform(
  node: WorkspaceLayoutNode | null,
  view: (id: string) => WorkspaceLayoutNode | null,
): WorkspaceLayoutNode | null {
  if (!node) return null;
  if (node.kind === 'view') return view(node.instanceId);
  if (node.kind === 'tabs') {
    const items = node.items.flatMap((item) => {
      const child = transform(item.node, view);
      return child ? [{ ...item, node: child }] : [];
    });
    if (!items.length) return null;
    return { ...node, items, active: items.some((item) => item.id === node.active) ? node.active : items[0]?.id ?? null };
  }
  if (node.kind === 'custom') return { ...node, children: (node.children ?? []).flatMap((child) => {
    const next = transform(child, view);
    return next ? [next] : [];
  }) };
  const retained = node.children.flatMap((child, at) => {
    const next = transform(child, view);
    return next ? [{ node: next, weight: node.weights[at] ?? 1 }] : [];
  });
  const children = retained.map((entry) => entry.node);
  if (!children.length) return null;
  if (children.length === 1) return children[0] ?? null;
  const total = retained.reduce((sum, entry) => sum + entry.weight, 0);
  return { ...node, children, weights: retained.map((entry) => entry.weight / total) };
}
export function removeView(layout: WorkspaceLayout, instanceId: string): WorkspaceLayout {
  return {
    ...layout, root: transform(layout.root, (id) => id === instanceId ? null : { kind: 'view', instanceId: id }),
    floating: layout.floating.filter((view) => view.instanceId !== instanceId),
    overlays: layout.overlays.filter((view) => view.instanceId !== instanceId),
  };
}
export function replaceView(layout: WorkspaceLayout, previous: string, next: string): WorkspaceLayout {
  return {
    ...layout,
    root: transform(layout.root, (id) => ({ kind: 'view', instanceId: id === previous ? next : id })),
    floating: layout.floating.map((view) => view.instanceId === previous ? { ...view, instanceId: next } : view),
    overlays: layout.overlays.map((view) => view.instanceId === previous ? { ...view, instanceId: next } : view),
  };
}
export function placeView(layout: WorkspaceLayout, instanceId: string, placement: Placement): WorkspaceLayout {
  const clean = removeView(layout, instanceId);
  const node: WorkspaceLayoutNode = { kind: 'view', instanceId };
  if (placement === 'floating' || placement === 'overlay') {
    const view = { instanceId, x: 24, y: 24, width: 408, height: 320, z: 1 };
    return placement === 'floating'
      ? { ...clean, floating: [...clean.floating, view] }
      : { ...clean, overlays: [...clean.overlays, { ...view, x: 40, y: 40, width: 300, height: 220 }] };
  }
  if (!clean.root) return { ...clean, root: node };
  if (placement === 'split')
    return { ...clean, root: { kind: 'split', direction: 'horizontal', weights: [0.6, 0.4], children: [clean.root, node] } };
  if (clean.root.kind === 'tabs') {
    const id = `tab.${instanceId}`;
    return { ...clean, root: { ...clean.root, active: id, items: [...clean.root.items, { id, node }] } };
  }
  return {
    ...clean, root: {
      kind: 'tabs', active: `tab.${instanceId}`,
      items: [{ id: `tab.previous.${instanceId}`, title: '原工作区', node: clean.root }, { id: `tab.${instanceId}`, node }],
    },
  };
}
export function reorderView(layout: WorkspaceLayout, instanceId: string, offset: -1 | 1): WorkspaceLayout {
  const ids = instancesIn(layout.root);
  const at = ids.indexOf(instanceId), neighbor = ids[at + offset];
  if (at < 0 || !neighbor) return layout;
  return {
    ...layout, root: transform(layout.root, (id) => ({
      kind: 'view', instanceId: id === instanceId ? neighbor : id === neighbor ? instanceId : id,
    })),
  };
}
export function selectTab(layout: WorkspaceLayout, path: readonly number[], itemId: string): WorkspaceLayout {
  const update = (node: WorkspaceLayoutNode, depth: number): WorkspaceLayoutNode => {
    if (depth === path.length)
      return node.kind === 'tabs' && node.items.some((item) => item.id === itemId) ? { ...node, active: itemId } : node;
    const position = path[depth];
    if (node.kind === 'view') return node;
    if (node.kind === 'tabs')
      return { ...node, items: node.items.map((item, at) => at === position ? { ...item, node: update(item.node, depth + 1) } : item) };
    return { ...node, children: (node.children ?? []).map((child, at) => at === position ? update(child, depth + 1) : child) };
  };
  return layout.root ? { ...layout, root: update(layout.root, 0) } : layout;
}
export function resizeSplit(layout: WorkspaceLayout, path: readonly number[], firstWeight: number): WorkspaceLayout {
  const weight = Math.min(0.85, Math.max(0.15, firstWeight));
  const update = (node: WorkspaceLayoutNode, depth: number): WorkspaceLayoutNode => {
    if (depth === path.length) {
      if (node.kind !== 'split' || node.children.length < 2) return node;
      return { ...node, weights: node.children.map((_child, at) => at === 0 ? weight : (1 - weight) / (node.children.length - 1)) };
    }
    const position = path[depth];
    if (node.kind === 'view') return node;
    if (node.kind === 'tabs')
      return { ...node, items: node.items.map((item, at) => at === position ? { ...item, node: update(item.node, depth + 1) } : item) };
    return { ...node, children: (node.children ?? []).map((child, at) => at === position ? update(child, depth + 1) : child) };
  };
  return layout.root ? { ...layout, root: update(layout.root, 0) } : layout;
}
export function changeFloating(
  layout: WorkspaceLayout, instanceId: string, value: Partial<Pick<WorkspaceFloatingView, 'x' | 'y' | 'width' | 'height' | 'z'>>,
): WorkspaceLayout {
  const update = <T extends WorkspaceFloatingView>(view: T): T => view.instanceId === instanceId ? {
    ...view,
    x: Math.round(Math.min(8000, Math.max(0, value.x ?? view.x))),
    y: Math.round(Math.min(8000, Math.max(0, value.y ?? view.y))),
    width: Math.round(Math.min(4000, Math.max(200, value.width ?? view.width))),
    height: Math.round(Math.min(3000, Math.max(140, value.height ?? view.height))),
    z: Math.round(Math.min(1000, Math.max(0, value.z ?? view.z))),
  } : view;
  return { ...layout, floating: layout.floating.map(update), overlays: layout.overlays.map(update) };
}
export function customChildren(node: WorkspaceLayoutNode): JsonValue {
  if (node.kind === 'view') return { kind: node.kind, instanceId: node.instanceId };
  if (node.kind === 'tabs')
    return { kind: node.kind, active: node.active, items: node.items.map((item) => ({ id: item.id, node: customChildren(item.node) })) };
  if (node.kind === 'split')
    return { kind: node.kind, direction: node.direction, weights: [...node.weights], children: node.children.map(customChildren) };
  return {
    kind: node.kind, provider: { ...node.provider }, data: node.data,
    children: (node.children ?? []).map(customChildren),
  };
}
