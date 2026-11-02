import type { Dispose, HostContext, WorkspaceViewRef } from '@deviceforge/plugin-sdk';
import { fileToolLayout } from './tool-layout.ts';

export const FILES_TOOLS_POINT = { id: 'deviceforge_files.tools', version: '1' };
const workspaceId = 'deviceforge_files.workspace', prefix = 'deviceforge_files.contribution.';
function reference(value: unknown): WorkspaceViewRef | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    'pluginId' in value && typeof value.pluginId === 'string' && value.pluginId.length > 0 &&
    'viewId' in value && typeof value.viewId === 'string' && value.viewId.length > 0
    ? { pluginId: value.pluginId, viewId: value.viewId } : null;
}

/** 文件页面自己消费公开贡献；扩展撤销时消费方仍存活，可立即恢复原区域。 */
export function registerFilesTools(context: HostContext): Dispose {
  const ui = context.ui, points = context.extensions?.points;
  if (!ui || !points) return () => {};
  const definition = points.define({ ...FILES_TOOLS_POINT, title: '文件工作区工具', modes: ['append'],
    inputSchema: { type: 'object', required: ['title', 'pluginId', 'viewId'], additionalProperties: false,
      properties: { title: { type: 'string', minLength: 1, maxLength: 120 },
        pluginId: { type: 'string', minLength: 1, maxLength: 128 }, viewId: { type: 'string', minLength: 1, maxLength: 200 } } },
  });
  const stale = new Set(ui.snapshot().instances.filter((entry) => entry.pluginId === 'deviceforge_files' &&
    entry.workspaceId === workspaceId && entry.instanceId.startsWith(prefix)).map((entry) => entry.instanceId));
  const retained = ui.readLayout(workspaceId);
  if (retained && stale.size) ui.writeLayout(workspaceId, fileToolLayout(retained, stale, []));
  for (const id of stale) ui.close(id);
  const bindings = new Map<string, string>();
  let sequence = 0, updating = false, closed = false;
  function refresh() {
    if (updating || closed || context.signal.aborted || !ui || !points) return;
    updating = true;
    const opened: string[] = [];
    try {
      const entries = points.list(FILES_TOOLS_POINT).flatMap((entry) => {
        const provider = reference(entry.data);
        return entry.state === 'active' && entry.mode === 'append' && provider
          ? [{ provider, key: JSON.stringify([entry.provider.pluginId, entry.provider.generation, entry.id, provider]) }] : [];
      });
      const previous = new Set(bindings.values()), active = new Set(entries.map((entry) => entry.key));
      for (const entry of entries) {
        if (bindings.has(entry.key)) continue;
        let id: string;
        do { id = `${prefix}${++sequence}`; } while (ui.snapshot().instances.some((instance) => instance.instanceId === id));
        ui.open({ instanceId: id, workspaceId, provider: entry.provider, target: null, visible: false }, context.signal);
        bindings.set(entry.key, id); opened.push(id);
      }
      const current = ui.readLayout(workspaceId);
      if (current) {
        const next = fileToolLayout(current, previous, entries.flatMap((entry) => {
          const id = bindings.get(entry.key); return id ? [id] : [];
        }));
        if (JSON.stringify(next) !== JSON.stringify(current)) ui.writeLayout(workspaceId, next);
      }
      for (const [key, id] of bindings) if (!active.has(key)) { bindings.delete(key); ui.close(id); }
    } catch (error) {
      for (const [key, id] of bindings) if (opened.includes(id)) {
        bindings.delete(key);
        try { ui.close(id); } catch { /* 作用域撤销仍由原内核收敛。 */ }
      }
      context.extensions?.emitEvent('deviceforge_files.tools.failed', {
        message: error instanceof Error ? error.message : '文件插件工具装配失败',
      });
    } finally { updating = false; }
  }
  const releasePoints = points.subscribe(refresh), releaseUi = ui.subscribe(refresh);
  refresh();
  return () => {
    if (closed) return;
    closed = true;
    void releasePoints(); void releaseUi();
    if (!context.signal.aborted) {
      const current = ui.readLayout(workspaceId);
      if (current) ui.writeLayout(workspaceId, fileToolLayout(current, new Set(bindings.values()), []));
      for (const id of bindings.values()) ui.close(id);
      void definition();
    }
    bindings.clear();
  };
}
