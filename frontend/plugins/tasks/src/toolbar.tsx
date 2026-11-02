import { useEffect, useState } from 'react';
import type { HostContext, LocalPointContribution, WorkspaceLayoutNode, WorkspaceViewRef } from '@deviceforge/plugin-sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { Button } from './view-support.tsx';

/** 工具栏只消费公开视图引用，挂载仍走宿主既有的有界挂载管线。 */
function viewReference(value: unknown): value is WorkspaceViewRef {
  return value !== null && typeof value === 'object' &&
    'pluginId' in value && typeof value.pluginId === 'string' &&
    'viewId' in value && typeof value.viewId === 'string';
}
function references(node: WorkspaceLayoutNode | null, id: string): boolean {
  if (!node) return false;
  if (node.kind === 'view') return node.instanceId === id;
  if (node.kind === 'tabs') return node.items.some((item) => references(item.node, id));
  return node.children?.some((item) => references(item, id)) ?? false;
}
export function TaskToolbar({ context, pointId }: { context: HostContext; pointId: string }) {
  const points = context.extensions?.points;
  const [entries, setEntries] = useState<readonly LocalPointContribution[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!points) return;
    const ref = { id: pointId, version: '1.0' };
    const refresh = () => setEntries(points.list(ref).filter((entry) => entry.state === 'active' && entry.mode === 'append'));
    refresh();
    const release = points.subscribe(refresh);
    return () => { void release(); };
  }, [points, pointId]);
  const ui = context.ui;
  if (!ui || !entries.length) return null;
  return <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 @min-[900px]/tasks:px-6" aria-label="插件任务工具">
    {entries.map((entry) => {
      const data = entry.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data) ||
        typeof data.title !== 'string' || !viewReference(data.view)) return null;
      const provider = data.view;
      return <Button key={entry.id} variant="outline" size="sm" onClick={() => {
        try {
          const digest = Array.from(sha256(new TextEncoder().encode(entry.id)), (byte) => byte.toString(16).padStart(2, '0')).join('');
          const instanceId = `${pointId}.tool.${digest}`;
          const workspaceId = `${pointId.slice(0, -'.toolbar'.length)}.workspace`;
          ui.open({
            instanceId, workspaceId, provider,
          }, context.signal);
          const layout = ui.readLayout(workspaceId);
          if (layout && !references(layout.root, instanceId) &&
            ![...layout.floating, ...layout.overlays].some((item) => item.instanceId === instanceId))
            ui.writeLayout(workspaceId, {
              ...layout, floating: [...layout.floating, { instanceId, x: 56, y: 56, width: 520, height: 360, z: layout.floating.length + 1 }],
            });
          setError(null);
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
      }}>{data.title}</Button>;
    })}
    {error && <span role="alert" className="text-[12px] text-[color:var(--destructive)]">{error}</span>}
  </div>;
}
