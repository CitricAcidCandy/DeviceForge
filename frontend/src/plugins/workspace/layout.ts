import type { WorkspaceLayout, WorkspaceLayoutNode } from '../../plugin-sdk/workspace.ts';
import { clone, invalid, record, requireId, requireJson, requireRef } from './rules.ts';

/** 验证与布局变换不访问 DOM，也不决定业务资源的启停。 */
export function validateWorkspaceLayout(value: unknown): asserts value is WorkspaceLayout {
  requireJson(value);
  if (!record(value) || value.version !== 1 || !Array.isArray(value.floating) || !Array.isArray(value.overlays))
    invalid('工作区布局版本或窗口列表无效');
  const instances = new Set<string>();
  let nodes = 0;
  const instance = (id: unknown) => {
    requireId(id);
    if (instances.has(id)) invalid('同一视图实例不能同时出现在多个布局位置');
    instances.add(id);
  };
  function node(item: unknown, depth: number): void {
    if (++nodes > 512 || depth > 16 || !record(item)) invalid('工作区布局层级或节点无效');
    if (item.kind === 'view') return instance(item.instanceId);
    if (item.kind === 'split') {
      if ((item.direction !== 'horizontal' && item.direction !== 'vertical') ||
          !Array.isArray(item.children) || item.children.length < 2 || item.children.length > 32 ||
          !Array.isArray(item.weights) || item.weights.length !== item.children.length ||
          !item.weights.every((weight: unknown) => typeof weight === 'number' && Number.isFinite(weight) && weight > 0))
        invalid('分栏方向、数量或尺寸权重无效');
      for (const child of item.children) node(child, depth + 1);
      return;
    }
    if (item.kind === 'tabs') {
      if (!Array.isArray(item.items) || item.items.length > 256) invalid('页签列表无效');
      const ids = new Set<string>();
      for (const tab of item.items) {
        if (!record(tab)) invalid('页签无效');
        requireId(tab.id);
        if (ids.has(tab.id) || (tab.title !== undefined && typeof tab.title !== 'string')) invalid('页签标识重复或名称无效');
        ids.add(tab.id);
        node(tab.node, depth + 1);
      }
      if (item.active !== null && (typeof item.active !== 'string' || !ids.has(item.active))) invalid('活动页签不存在');
      return;
    }
    if (item.kind === 'custom') {
      requireRef(item.provider);
      requireJson(item.data);
      if (item.children !== undefined) {
        if (!Array.isArray(item.children) || item.children.length > 256) invalid('自定义布局子项无效');
        for (const child of item.children) node(child, depth + 1);
      }
      return;
    }
    invalid('未知的工作区布局节点');
  }
  if (value.root !== null) node(value.root, 0);
  if (value.floating.length + value.overlays.length > 256) invalid('悬浮窗口数量超过限制');
  for (const window of [...value.floating, ...value.overlays]) {
    if (!record(window)) invalid('悬浮窗口无效');
    instance(window.instanceId);
    if (![window.x, window.y].every((item: unknown) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1000000) ||
        ![window.width, window.height].every((item: unknown) => typeof item === 'number' && Number.isFinite(item) && item > 0 && item <= 1000000) ||
        typeof window.z !== 'number' || !Number.isSafeInteger(window.z) || window.z < 0 || window.z > 1000000)
      invalid('悬浮窗口的坐标、尺寸或层级无效');
    if (window.relativeTo !== undefined) requireId(window.relativeTo);
  }
}

export function removeFromLayout(layout: WorkspaceLayout, instanceId: string): WorkspaceLayout {
  function prune(node: WorkspaceLayoutNode): WorkspaceLayoutNode | null {
    if (node.kind === 'view') return node.instanceId === instanceId ? null : node;
    if (node.kind === 'split') {
      const children: WorkspaceLayoutNode[] = [];
      const weights: number[] = [];
      node.children.forEach((child, index) => {
        const next = prune(child);
        if (next) { children.push(next); weights.push(node.weights[index] ?? 1); }
      });
      if (children.length === 0) return null;
      if (children.length === 1) return children[0] ?? null;
      return { ...node, children, weights };
    }
    if (node.kind === 'tabs') {
      const items: { id: string; title?: string; node: WorkspaceLayoutNode }[] = [];
      for (const item of node.items) {
        const next = prune(item.node);
        if (next) items.push({ ...item, node: next });
      }
      if (items.length === 0) return null;
      const active = items.some((item) => item.id === node.active) ? node.active : items[0]?.id ?? null;
      return { ...node, active, items };
    }
    if (!node.children) return node;
    const children: WorkspaceLayoutNode[] = [];
    for (const child of node.children) {
      const next = prune(child);
      if (next) children.push(next);
    }
    return { ...node, children };
  }
  return clone({
    ...layout,
    root: layout.root ? prune(layout.root) : null,
    floating: layout.floating.filter((item) => item.instanceId !== instanceId),
    overlays: layout.overlays.filter((item) => item.instanceId !== instanceId && item.relativeTo !== instanceId),
  });
}

export function layoutInstanceIds(layout: WorkspaceLayout): ReadonlySet<string> {
  const ids = new Set<string>();
  function visit(node: WorkspaceLayoutNode) {
    if (node.kind === 'view') ids.add(node.instanceId);
    else if (node.kind === 'tabs') for (const item of node.items) visit(item.node);
    else if (node.kind === 'split') for (const child of node.children) visit(child);
    else if (node.children) for (const child of node.children) visit(child);
  }
  if (layout.root) visit(layout.root);
  for (const item of [...layout.floating, ...layout.overlays]) ids.add(item.instanceId);
  return ids;
}
