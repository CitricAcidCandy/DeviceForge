import type { TreeDiff, TreeSnapshot } from './contracts.ts';
import { jsonBytes, MAX_BYTES } from './json.ts';

export function diffTrees(before: TreeSnapshot, after: TreeSnapshot): TreeDiff {
  if (before.owner.pluginId !== after.owner.pluginId || before.owner.generation !== after.owner.generation ||
      before.owner.instanceId !== after.owner.instanceId || before.id.split(':snapshot:')[0] !== after.id.split(':snapshot:')[0])
    return { status: 'indeterminate', truncated: false, added: [], removed: [], changed: [], reason: '快照不属于同一目标代际和观测器' };
  const previous = new Map(before.nodes.map((node) => [node.id, node]));
  const current = new Map(after.nodes.map((node) => [node.id, node]));
  const added = after.nodes.filter((node) => !previous.has(node.id));
  const changed = after.nodes.filter((node) => {
    const old = previous.get(node.id);
    return old !== undefined && (old.generation !== node.generation || old.revision !== node.revision ||
      JSON.stringify(old.layout) !== JSON.stringify(node.layout));
  });
  const uncertain = before.coverage.truncation.length > 0 || after.coverage.truncation.length > 0 ||
    before.coverage.opaque > 0 || after.coverage.opaque > 0 ||
    before.coverage.excludedPluginRoots > 0 || after.coverage.excludedPluginRoots > 0;
  // 覆盖不完整时不能把缺席节点断言为删除，只报告可证实的新增和变更。
  const removed = uncertain ? [] : before.nodes.filter((node) => !current.has(node.id))
    .map(({ id, generation, revision }) => ({ id, generation, revision }));
  let response: TreeDiff = { status: uncertain ? 'indeterminate' : 'comparable', truncated: false, added, removed, changed,
    reason: uncertain ? '覆盖不完整，缺席节点不能确认为已删除' : null };
  while (jsonBytes(response) > MAX_BYTES) {
    if (removed.length) removed.pop(); else if (changed.length) changed.pop(); else added.pop();
    response = { ...response, status: 'indeterminate', truncated: true, reason: '差异响应达到1MiB限额，不能作为完整增删结果' };
  }
  return response;
}
