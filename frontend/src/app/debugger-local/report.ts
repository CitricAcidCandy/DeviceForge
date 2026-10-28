import type { AttachedDebug, ResolvedTarget } from './types.ts';
import type { TreeSnapshot } from '../../plugins/debugger/index.ts';
import { fail, integer, keys, text } from './validation.ts';

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function localReport(target: ResolvedTarget, entry: AttachedDebug | undefined, evidence: unknown, input: Record<string, unknown>) {
  keys(input, ['root_id', 'snapshot_id', 'offset', 'limit']);
  if (input.root_id !== undefined || input.snapshot_id !== undefined || input.offset !== undefined || input.limit !== undefined) {
    const rootId = text(input.root_id, '报告挂载根');
    const snapshotId = text(input.snapshot_id, '报告快照标识');
    const offset = input.offset === undefined ? 0 : integer(input.offset, '报告页偏移', 0, 5000);
    const limit = input.limit === undefined ? 500 : integer(input.limit, '报告页条数', 1, 500);
    const tree = entry?.collectors.get(rootId)?.collector.page(snapshotId, offset, limit);
    if (!tree) return fail('snapshot_unavailable', '报告快照已过期、挂载已撤销或不属于当前目标');
    return { format: 'deviceforge-debugger-local-v1', target, root_id: rootId, tree,
      limitations: ['当前页为冻结JSON证据；nextOffset非空时须继续读取同一snapshot_id', '持久化与产物导出由后端负责'] };
  }
  const manifest = [...(entry?.collectors.entries() ?? [])].map(([root_id, item]) => ({ root_id,
    snapshots: item.collector.snapshots().map((snapshot) => ({ id: snapshot.id, total: snapshot.page.total,
      pages: Math.max(1, Math.ceil(snapshot.page.total / 500)), observedAt: snapshot.observedAt })) }));
  const cached: { root_id: string; snapshots: TreeSnapshot[] }[] = [];
  const response: { format: string; evidence: unknown; snapshot_manifest: typeof manifest; cached_trees: typeof cached;
    continuation: { root_id: string; snapshot_id: string; offset: number } | null; limitations: string[] } = {
    format: 'deviceforge-debugger-local-v1', evidence, snapshot_manifest: manifest, cached_trees: cached, continuation: null,
    limitations: ['只导出所选目标的已采快照，不自动打开页面或采集DOM',
      '每页最多500节点、总响应1MiB、每根最近10逻辑快照；continuation指定报告下一页',
      '不是安装、整套release重载或生产验收报告；持久化由后端负责'] };
  if (size(response) > 1024 * 1024 - 8192) {
    response.evidence = { target, status: 'metadata_omitted', reason: '元数据过大，须通过inspect独立读取；报告优先保留快照证据' };
  }
  for (const [rootId, item] of entry?.collectors.entries() ?? []) {
    const group: { root_id: string; snapshots: TreeSnapshot[] } = { root_id: rootId, snapshots: [] };
    cached.push(group);
    for (const snapshot of item.collector.snapshots()) {
      for (const page of item.collector.pages(snapshot.id)) {
        group.snapshots.push(page);
        if (size(response) > 1024 * 1024 - 8192) {
          group.snapshots.pop();
          response.continuation = { root_id: rootId, snapshot_id: snapshot.id, offset: page.page.offset };
          return response;
        }
      }
    }
  }
  return response;
}
