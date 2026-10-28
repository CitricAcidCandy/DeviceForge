import { text } from './protocol.ts';
import type { UiNode } from './protocol.ts';
export interface NodeFilter { readonly name: string; readonly role: string; readonly hidden: string; readonly disabled: string }
export function nodeDepth(node: UiNode, nodes: readonly UiNode[]): number {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const seen = new Set([node.id]); let parent = node.parentId, depth = 0;
  while (parent && depth < 32 && !seen.has(parent)) { seen.add(parent); depth++; parent = byId.get(parent)?.parentId ?? null; }
  return depth;
}
export function filterNodes(nodes: readonly UiNode[], filter: NodeFilter, collapsed: ReadonlySet<string>, query: readonly string[] | null): UiNode[] {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const matches = nodes.filter((node) => (!filter.name || `${node.name} ${node.id}`.toLocaleLowerCase().includes(filter.name.toLocaleLowerCase())) &&
    (!filter.role || node.role === filter.role) && (!filter.hidden || text(node.raw.hidden) === filter.hidden) &&
    (!filter.disabled || text(node.raw.disabled) === filter.disabled) && (!query || query.includes(node.id)));
  const searching = Boolean(filter.name || filter.role || filter.hidden || filter.disabled || query);
  const accepted = new Set(matches.map((node) => node.id));
  if (searching) for (const node of matches) {
    let parent = node.parentId; const seen = new Set<string>();
    while (parent && !seen.has(parent)) { seen.add(parent); accepted.add(parent); parent = byId.get(parent)?.parentId ?? null; }
  }
  return nodes.filter((node) => {
    if (!accepted.has(node.id)) return false;
    if (searching) return true;
    let parent = node.parentId; const seen = new Set<string>();
    while (parent && !seen.has(parent)) { if (collapsed.has(parent)) return false; seen.add(parent); parent = byId.get(parent)?.parentId ?? null; }
    return true;
  });
}
