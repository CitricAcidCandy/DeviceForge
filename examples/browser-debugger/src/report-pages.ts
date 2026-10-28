import { array, number, object, text } from './protocol.ts';
import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';

export function nextReportPage(value: JsonValue): { rootId: string; snapshotId: string; offset: number } | null {
  const wrapper = object(value), evidence = object(object(wrapper.report).evidence);
  const pages: { rootId: string; snapshotId: string; offset: number; count: number }[] = [];
  for (const group of array(evidence.cached_trees)) {
    const item = object(group);
    for (const snapshot of array(item.snapshots)) {
      const tree = object(snapshot), page = object(tree.page);
      pages.push({ rootId: text(item.root_id), snapshotId: text(tree.id), offset: number(page.offset), count: array(tree.nodes).length });
    }
  }
  for (const raw of array(wrapper.ui_snapshot_pages)) {
    const item = object(raw), tree = object(item.tree), page = object(tree.page);
    pages.push({ rootId: text(item.root_id), snapshotId: text(tree.id), offset: number(page.offset), count: array(tree.nodes).length });
  }
  for (const raw of array(evidence.snapshot_manifest)) {
    const group = object(raw), rootId = text(group.root_id);
    for (const rawSnapshot of array(group.snapshots)) {
      const snapshot = object(rawSnapshot), snapshotId = text(snapshot.id), total = number(snapshot.total);
      let offset = 0;
      while (offset < total) {
        const page = pages.find((item) => item.rootId === rootId && item.snapshotId === snapshotId && item.offset === offset && item.count > 0);
        if (!page) return { rootId, snapshotId, offset };
        offset += page.count;
      }
    }
  }
  return null;
}
