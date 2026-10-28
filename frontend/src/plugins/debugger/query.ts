import type { TreeQuery, TreeQueryResult, TreeSnapshot, UiNode } from './contracts.ts';

export function queryTree(snapshot: TreeSnapshot, query: TreeQuery): TreeQueryResult {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  function descendant(node: UiNode): boolean {
    if (query.descendantOf === undefined) return true;
    let parent = node.parentId;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      if (parent === query.descendantOf) return true;
      visited.add(parent); parent = byId.get(parent)?.parentId ?? null;
    }
    return false;
  }
  const matches = snapshot.nodes.filter((node) =>
    (query.id === undefined || node.id === query.id) &&
    (query.role === undefined || node.role === query.role) &&
    (query.name === undefined || node.name === query.name) &&
    (query.surfaceId === undefined || node.surfaceId === query.surfaceId) &&
    (query.hidden === undefined || node.hidden === query.hidden) &&
    (query.disabled === undefined || node.disabled === query.disabled) && descendant(node));
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500))
    throw new Error('树查询条数必须在1到500之间');
  const limit = query.limit ?? 500;
  const reasons: string[] = [];
  if (snapshot.coverage.truncation.length) reasons.push('快照存在截断');
  if (snapshot.coverage.opaque) reasons.push('存在不透明内容');
  if (snapshot.coverage.excludedPluginRoots) reasons.push('已排除其他插件或旧代根');
  if (snapshot.nodes.some((node) => node.virtual === 'declared')) reasons.push('虚拟内容的未挂载节点未知');
  if (query.descendantOf !== undefined && !byId.has(query.descendantOf)) reasons.push('查询祖先不在快照中');
  if (matches.length > limit) reasons.push('查询条数截断');
  return { nodes: matches.slice(0, limit), complete: reasons.length === 0,
    reason: reasons.length ? reasons.join('；') : null };
}
