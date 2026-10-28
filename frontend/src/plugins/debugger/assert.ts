import type { TreeAssertion, TreeAssertionResult, TreeSnapshot } from './contracts.ts';
import { queryTree } from './query.ts';

export function assertTree(snapshot: TreeSnapshot, assertion: TreeAssertion): TreeAssertionResult {
  const result = queryTree(snapshot, assertion.query);
  const matched = result.nodes.length;
  const response = (status: TreeAssertionResult['status'], reason: string): TreeAssertionResult => ({ status, reason, matched });
  if (assertion.condition === 'exists' && matched > 0) return response('passed', '在当前DOM证据内找到节点');
  if (assertion.condition === 'absent' && matched > 0) return response('failed', '当前DOM证据内仍存在节点');
  if (assertion.condition === 'count') {
    if (!Number.isSafeInteger(assertion.expected) || assertion.expected < 0) throw new Error('断言数量必须是非负安全整数');
    if (matched > assertion.expected) return response('failed', '已观测数量超过预期');
    if (!result.complete) return response('indeterminate', result.reason ?? '覆盖不足');
    return response(matched === assertion.expected ? 'passed' : 'failed', '仅比较当前已挂载DOM节点数量，不涵盖虚拟或未挂载节点');
  }
  if (!result.complete) return response('indeterminate', result.reason ?? '覆盖不足');
  if (assertion.condition === 'exists') return response('failed', '当前已挂载DOM内未找到节点，未挂载内容未知');
  if (assertion.condition === 'absent') return response('passed', '当前已挂载DOM内不存在节点，未挂载内容未知');
  if (!matched) return response('indeterminate', '缺少可判断状态的目标节点');
  if (['in_viewport', 'within_root', 'unclipped', 'nonzero_size'].includes(assertion.condition)) {
    const states = result.nodes.map((node) => assertion.condition === 'in_viewport' ? node.layout.inViewport
      : assertion.condition === 'within_root' ? node.layout.withinRoot
      : assertion.condition === 'nonzero_size' ? node.layout.nonzeroSize
      : node.layout.clipped === 'yes' ? 'no' : node.layout.clipped === 'no' ? 'yes' : 'unknown');
    if (states.includes('no')) return response('failed', '至少一个节点的客户端布局不满足断言');
    return states.includes('unknown') ? response('indeterminate', '客户端布局或裁切证据不足')
      : response('passed', '客户端布局满足断言；不证明像素可见或未被遮挡');
  }
  const states = result.nodes.map((node) => assertion.condition === 'enabled' ? node.disabled
    : assertion.condition === 'visible' ? node.visible === 'yes' ? 'no' : node.visible === 'no' ? 'yes' : 'unknown' : node.invalid);
  if (states.includes('yes')) return response('failed', '至少一个节点的公开DOM状态不满足断言');
  if (states.includes('unknown')) return response('indeterminate', '公开DOM没有提供足够的状态证据');
  return response('passed', '当前公开DOM状态满足断言，不证明遮挡、框架状态或业务成功');
}
