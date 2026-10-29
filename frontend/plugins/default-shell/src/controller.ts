import type {
  Dispose, HostContext, UiAccess, WorkspacePageInfo, WorkspaceViewRef, WorkspaceLayout,
  WorkspaceLayoutNode, WorkspaceSnapshot,
} from '@deviceforge/plugin-sdk';
import type { MountPool } from './mount-pool.ts';
import {
  emptyLayout, placeView, replaceView, reorderView, resizeSplit, selectTab,
  changeFloating, visibleInstances, instancesIn, customChildren,
} from './layout.ts';
import type { Placement } from './layout.ts';

export interface VisitedPage { readonly page: WorkspacePageInfo; readonly workspaceId: string }
export interface ShellState {
  readonly model: WorkspaceSnapshot;
  readonly pages: readonly WorkspacePageInfo[];
  readonly visited: readonly VisitedPage[];
  readonly route: string;
  readonly current: VisitedPage | null;
  readonly available: boolean;
  readonly compact: boolean;
  readonly compactView: string | null;
  readonly notice: string | null;
  readonly preparing: number;
}
export const normalizeRoute = (route: string): string => `/${route.replace(/^#?\/?/, '').replace(/\/+$/, '')}`;
function requireUi(value: UiAccess | undefined): UiAccess {
  if (!value) throw new Error('当前平台未提供工作区能力');
  return value;
}
export function identity(value: string): string {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
export function createShellController(context: HostContext, pool: MountPool, initialRoute: string) {
  const ui = requireUi(context.ui);
  const visited = new Map<string, VisitedPage>();
  const listeners = new Set<() => void>();
  let route = normalizeRoute(initialRoute);
  let compact = false, compactView: string | null = null;
  let notice: string | null = null, preparing = 0, sequence = 0;
  let closed = false, refreshing = false;
  let state: ShellState;
  function currentPage(): VisitedPage | null {
    return [...visited.values()].find((entry) => normalizeRoute(entry.page.route) === route) ?? null;
  }
  function layout(page = currentPage()): WorkspaceLayout {
    return page ? ui.readLayout(page.workspaceId) ?? emptyLayout() : emptyLayout();
  }
  function nextId(kind: string): string {
    let id: string;
    do { id = `deviceforge_shell.${kind}.${++sequence}`; }
    while (ui.snapshot().instances.some((instance) => instance.instanceId === id));
    return id;
  }
  function ensurePage(page: WorkspacePageInfo) {
    const workspaceId = page.workspaceId ?? page.id;
    visited.set(page.id, { page, workspaceId });
    const saved = ui.readLayout(workspaceId);
    if (saved) {
      const retained = new Set([...instancesIn(saved.root), ...saved.floating.map((view) => view.instanceId), ...saved.overlays.map((view) => view.instanceId)]);
      for (const instance of ui.snapshot().instances) {
        if (retained.has(instance.instanceId) && instance.pluginId === 'deviceforge_shell' && instance.reason === 'owner_inactive')
          ui.open({ instanceId: instance.instanceId, workspaceId, provider: instance.provider, target: instance.target, visible: false });
      }
      return;
    }
    if (!page.viewId) return;
    const instanceId = `deviceforge_shell.page.${identity(page.id)}`;
    ui.open({
      instanceId, workspaceId, provider: { pluginId: page.pluginId, viewId: page.viewId }, visible: false,
    });
    ui.writeLayout(workspaceId, { ...emptyLayout(), root: { kind: 'view', instanceId } });
  }
  function refresh() {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const pages = [...ui.catalog().pages].sort((a, b) =>
        (a.navigation?.order ?? 100) - (b.navigation?.order ?? 100) || a.id.localeCompare(b.id));
      if (route === '/') {
        const first = pages.find((page) => !page.navigation?.hidden) ?? pages[0];
        if (first) route = normalizeRoute(first.route);
      }
      const available = pages.find((page) => normalizeRoute(page.route) === route);
      if (available) ensurePage(available);
      const current = currentPage();
      const activeLayout = layout(current);
      const all = [...instancesIn(activeLayout.root), ...activeLayout.floating.map((view) => view.instanceId),
        ...activeLayout.overlays.map((view) => view.instanceId)];
      if (!compactView || !all.includes(compactView)) compactView = all[0] ?? null;
      const visible = compact ? new Set(compactView ? [compactView] : []) : visibleInstances(activeLayout);
      const visibleCustom = new Set<string>();
      const collectCustom = (node: WorkspaceLayoutNode | null, path: readonly number[]) => {
        if (!node || !current) return;
        if (node.kind === 'custom') visibleCustom.add(`deviceforge_shell.custom.${identity(`${current.workspaceId}:${path.join('.')}`)}`);
        if (node.kind === 'tabs') {
          const selected = node.items.findIndex((item) => item.id === node.active);
          const at = Math.max(0, selected), child = node.items[at];
          if (child) collectCustom(child.node, [...path, at]);
        } else if (node.kind !== 'view') (node.children ?? []).forEach((child, at) => collectCustom(child, [...path, at]));
      };
      if (!compact || !compactView) collectCustom(activeLayout.root, []);
      const managed = new Set([...visited.values()].map((page) => page.workspaceId));
      for (const instance of ui.snapshot().instances) {
        if (!managed.has(instance.workspaceId)) continue;
        const desired = instance.workspaceId === current?.workspaceId &&
          (visible.has(instance.instanceId) || visibleCustom.has(instance.instanceId));
        if (instance.visible !== desired) ui.setVisible(instance.instanceId, desired);
      }
      state = Object.freeze({
        model: ui.snapshot(), pages, visited: [...visited.values()], route, current,
        available: !!available, compact, compactView, notice, preparing,
      });
    } finally { refreshing = false; }
    for (const listener of [...listeners]) listener();
  }
  function update(next: WorkspaceLayout) {
    const page = currentPage();
    if (!page) throw new Error('请先选择可用页面');
    ui.writeLayout(page.workspaceId, next);
    notice = '布局已更新';
    refresh();
  }
  async function prepared(ref: WorkspaceViewRef, placement: Placement, previous?: string, caller?: AbortSignal) {
    const page = currentPage();
    if (!page) throw new Error('请先选择可用页面');
    const source = previous ? ui.snapshot().instances.find((entry) => entry.instanceId === previous) : null;
    if (previous && !source) throw new Error('原视图已关闭，请重新选择');
    const id = nextId('view');
    const aborted = () => { if (!context.signal.aborted) ui.close(id); };
    if (caller?.aborted) throw new Error('视图准备已取消');
    caller?.addEventListener('abort', aborted, { once: true });
    preparing++; notice = '正在准备所选视图，原工作区保持可用'; refresh();
    try {
      ui.open({
        instanceId: id, workspaceId: page.workspaceId, provider: ref,
        target: source?.target ?? null, visible: false,
      });
      await pool.prepare(id);
      if (closed || context.signal.aborted || caller?.aborted) throw new Error('视图准备已撤销');
      const currentSource = source ? ui.snapshot().instances.find((entry) => entry.instanceId === source.instanceId) : null;
      if (source && currentSource?.generation !== source.generation) throw new Error('原视图已变化，请重新选择');
      const original = ui.readLayout(page.workspaceId) ?? emptyLayout();
      ui.writeLayout(page.workspaceId, previous ? replaceView(original, previous, id) : placeView(original, id, placement));
      if (previous) { ui.close(previous); compactView = id; }
      notice = previous ? '提供者已更换' : '功能已加入工作区';
      return id;
    } catch (error) {
      if (!context.signal.aborted) ui.close(id);
      notice = error instanceof Error ? error.message : '视图准备失败，已保留原工作区';
      throw error;
    } finally { caller?.removeEventListener('abort', aborted); preparing--; refresh(); }
  }
  const unsubscribe = ui.subscribe(refresh);
  refresh();
  return {
    snapshot: (): ShellState => state,
    subscribe(listener: () => void): Dispose { listeners.add(listener); return () => { listeners.delete(listener); }; },
    navigate(value: string) { route = normalizeRoute(value); notice = null; refresh(); },
    setCompact(value: boolean) { if (compact !== value) { compact = value; refresh(); } },
    selectCompact(instanceId: string) { compactView = instanceId; refresh(); },
    add: (ref: WorkspaceViewRef, placement: Placement, signal?: AbortSignal) => prepared(ref, placement, undefined, signal),
    replace: (instanceId: string, ref: WorkspaceViewRef, signal?: AbortSignal) => prepared(ref, 'split', instanceId, signal),
    close(instanceId: string) { ui.close(instanceId); notice = '视图已关闭'; refresh(); },
    place(instanceId: string, placement: Placement) { update(placeView(layout(), instanceId, placement)); },
    reorder(instanceId: string, offset: -1 | 1) { update(reorderView(layout(), instanceId, offset)); },
    selectTab(path: readonly number[], id: string) { update(selectTab(layout(), path, id)); },
    resizeSplit(path: readonly number[], value: number) { update(resizeSplit(layout(), path, value)); },
    float(instanceId: string, value: Parameters<typeof changeFloating>[2]) { update(changeFloating(layout(), instanceId, value)); },
    ensureCustom(workspaceId: string, path: string, node: Extract<WorkspaceLayoutNode, { kind: 'custom' }>) {
      const instanceId = `deviceforge_shell.custom.${identity(`${workspaceId}:${path}`)}`;
      const target = { data: node.data, children: (node.children ?? []).map(customChildren) };
      const existing = ui.snapshot().instances.find((instance) => instance.instanceId === instanceId);
      if (!existing || existing.reason === 'owner_inactive')
        ui.open({ instanceId, workspaceId, provider: node.provider, target, visible: true });
      else if (JSON.stringify(existing.target) !== JSON.stringify(target)) ui.setTarget(instanceId, target);
      return instanceId;
    },
    dispose() { closed = true; unsubscribe(); listeners.clear(); },
  };
}
export type ShellController = ReturnType<typeof createShellController>;
