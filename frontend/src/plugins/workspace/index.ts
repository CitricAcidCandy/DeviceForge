import { HostError } from '../../plugin-sdk/models.ts';
import type { Dispose } from '../../plugin-sdk/models.ts';
import type {
  UiAccess, WorkspaceCatalog, WorkspaceContributions, WorkspaceDefinition,
  WorkspacePageDefinition, WorkspaceSavedState, WorkspaceSnapshot, WorkspaceViewDefinition,
} from '../../plugin-sdk/workspace.ts';
import { createInstanceStore } from './instances.ts';
import type { OwnedWorkspace, WorkspaceOwner } from './instances.ts';
import { layoutInstanceIds, removeFromLayout, validateWorkspaceLayout } from './layout.ts';
import { validateSavedState } from './persistence.ts';
import { updatedPageMetadata, validatePageMetadata } from './pages.ts';
import { clone, frozen, invalid, notify, requireId, requireOwnedId, requirePluginId, requireTitle } from './rules.ts';
import type { WorkspaceLayout } from '../../plugin-sdk/workspace.ts';

export { validateWorkspaceLayout } from './layout.ts';
export { scopedWorkspaceAccess } from './scoped.ts';
export type { WorkspaceOwner } from './instances.ts';

interface PageEntry<T> { readonly owner: WorkspaceOwner; definition: T }

/** 仅管理声明、布局和运行身份；实际挂载由渲染宿主使用现有挂载期限执行。 */
export function createWorkspaceRegistry(options: { readonly initial?: unknown } = {}) {
  const pages = new Map<string, PageEntry<WorkspacePageDefinition>>();
  const workspaces = new Map<string, OwnedWorkspace<WorkspaceDefinition>>();
  const views = new Map<string, OwnedWorkspace<WorkspaceViewDefinition>>();
  const pageViews = new Map<string, PageEntry<WorkspaceViewDefinition>>();
  const layouts = new Map<string, WorkspaceLayout>();
  const releases = new Set<Dispose>();
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let closed = false;
  let revision = 0;
  let catalogCache: WorkspaceCatalog | null = null;
  let snapshotCache: WorkspaceSnapshot | null = null;
  let batching = 0;
  let pending = false;
  const check = () => {
    if (closed) throw new HostError('cancelled', 'workspace_closed', '工作区注册表已关闭');
  };
  function changed(directory = false) {
    snapshotCache = null;
    if (directory) catalogCache = null;
    revision++;
    if (batching) pending = true;
    else notify(listeners);
  }
  function batch(run: () => void) {
    batching++;
    try { run(); }
    finally {
      batching--;
      if (!batching && pending) { pending = false; notify(listeners); }
    }
  }
  const instances = createInstanceStore((ref) => {
    const entry = views.get(ref.viewId) ?? pageViews.get(ref.viewId);
    return entry?.owner.pluginId === ref.pluginId && !entry.owner.signal.aborted ? entry : null;
  }, changed);
  function catalog(): WorkspaceCatalog {
    check();
    catalogCache ??= frozen({
      pages: [...pages.values()].map(({ owner, definition }) => ({
        id: definition.id, title: definition.title, pluginId: owner.pluginId, generation: owner.generation,
        route: definition.route, workspaceId: definition.workspaceId ?? null,
        viewId: definition.mount ? definition.id : null,
        ...(definition.navigation ? { navigation: definition.navigation } : {}),
        ...(definition.operations ? { operations: definition.operations } : {}),
        ...(definition.taskPolicy ? { taskPolicy: definition.taskPolicy } : {}),
      })),
      workspaces: [...workspaces.values()].map(({ owner, definition }) => ({
        id: definition.id, title: definition.title, pluginId: owner.pluginId, generation: owner.generation,
      })),
      views: [...views.values(), ...pageViews.values()].map(({ owner, definition }) => ({
        id: definition.id, title: definition.title, pluginId: owner.pluginId, generation: owner.generation,
        provides: definition.provides ?? [],
      })),
    });
    return catalogCache;
  }
  function snapshot(): WorkspaceSnapshot {
    check();
    snapshotCache ??= frozen({ revision, catalog: catalog(), instances: instances.values(),
      layouts: [...layouts].map(([workspaceId, layout]) => ({ workspaceId, layout })),
    });
    return snapshotCache;
  }
  function checkInstanceWorkspace(workspaceId: string, layout: WorkspaceLayout) {
    const referenced = layoutInstanceIds(layout);
    if (instances.values().some((entry) => referenced.has(entry.instanceId) && entry.workspaceId !== workspaceId))
      invalid('布局不能引用属于其他工作区的视图实例');
  }
  function register(owner: WorkspaceOwner, value: WorkspaceContributions): Dispose {
    check();
    const additions = [value.pages ?? [], value.workspaces ?? [], value.views ?? []];
    if (!additions.every(Array.isArray) || additions.some((items) => items.length > 256)) invalid('工作区贡献列表无效或过多');
    if (pages.size + (value.pages?.length ?? 0) > 128 || workspaces.size + (value.workspaces?.length ?? 0) > 128 ||
        views.size + (value.views?.length ?? 0) > 256) invalid('工作区贡献数量超过限制');
    const ids = new Set<string>();
    for (const item of additions.flat()) {
      requireOwnedId(owner.pluginId, item.id);
      requireTitle(item.title);
      if (ids.has(item.id) || pages.has(item.id) || workspaces.has(item.id) || views.has(item.id)) invalid('工作区贡献标识重复');
      ids.add(item.id);
    }
    // 同一提供者不能重复声明路径；跨提供者保留目录供外壳诊断，不按注册先后抢占。
    const routes = new Set([...pages.values()].filter((entry) => entry.owner.pluginId === owner.pluginId)
      .map((entry) => entry.definition.route));
    for (const page of value.pages ?? []) {
      if (typeof page.route !== 'string' || !page.route.startsWith('/') || page.route.startsWith('//') || /[?#\\]/.test(page.route) || page.route.length > 512)
        invalid('页面路由必须是无查询参数的本地路径');
      if (routes.has(page.route)) invalid('页面路由重复');
      routes.add(page.route);
      if (page.workspaceId !== undefined) requireId(page.workspaceId);
      if (page.mount !== undefined && typeof page.mount !== 'function') invalid('页面挂载函数无效');
      if (!page.mount && !page.workspaceId) invalid('页面必须指定工作区或挂载函数');
      validatePageMetadata(page);
    }
    for (const workspace of value.workspaces ?? []) {
      if (workspace.defaultLayout !== undefined) {
        validateWorkspaceLayout(workspace.defaultLayout);
        checkInstanceWorkspace(workspace.id, workspace.defaultLayout);
      }
    }
    const newLayouts = (value.workspaces ?? []).filter((entry) => entry.defaultLayout !== undefined && !layouts.has(entry.id));
    if (layouts.size + newLayouts.length > 128) invalid('工作区布局数量超过限制');
    for (const view of value.views ?? []) {
      if (typeof view.mount !== 'function' || (view.provides !== undefined &&
          (!Array.isArray(view.provides) || view.provides.length > 64 || view.provides.some((item) => typeof item !== 'string' || !item || item.length > 200))))
        invalid('视图挂载函数或提供的能力无效');
    }
    const ownedPages = (value.pages ?? []).map((definition) => ({ owner, definition: Object.freeze({
      ...definition,
      ...(definition.navigation ? { navigation: clone(definition.navigation) } : {}),
      ...(definition.operations ? { operations: clone(definition.operations) } : {}),
    }) }));
    const ownedPageViews: OwnedWorkspace<WorkspaceViewDefinition>[] = ownedPages.flatMap(({ definition }) =>
      definition.mount ? [{ owner, definition: Object.freeze({
        id: definition.id, title: definition.title, mount: definition.mount, provides: ['host.page'],
      }) }] : []);
    const ownedWorkspaces = (value.workspaces ?? []).map((definition) => ({ owner, definition: frozen({
      ...definition, ...(definition.defaultLayout ? { defaultLayout: clone(definition.defaultLayout) } : {}),
    }) }));
    const ownedViews = (value.views ?? []).map((definition) => ({ owner, definition: frozen({
      ...definition, ...(definition.provides ? { provides: [...definition.provides] } : {}),
    }) }));
    for (const entry of ownedPages) pages.set(entry.definition.id, entry);
    for (const entry of ownedPageViews) pageViews.set(entry.definition.id, entry);
    for (const entry of ownedWorkspaces) {
      workspaces.set(entry.definition.id, entry);
      if (!layouts.has(entry.definition.id) && entry.definition.defaultLayout) layouts.set(entry.definition.id, entry.definition.defaultLayout);
    }
    for (const entry of ownedViews) views.set(entry.definition.id, entry);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releases.delete(release);
      owner.signal.removeEventListener('abort', release);
      for (const entry of ownedPages) if (pages.get(entry.definition.id) === entry) pages.delete(entry.definition.id);
      for (const entry of ownedPageViews) if (pageViews.get(entry.definition.id) === entry) pageViews.delete(entry.definition.id);
      for (const entry of ownedWorkspaces) if (workspaces.get(entry.definition.id) === entry) workspaces.delete(entry.definition.id);
      for (const entry of ownedViews) if (views.get(entry.definition.id) === entry) views.delete(entry.definition.id);
      instances.reconcile();
      changed(true);
    };
    releases.add(release);
    owner.signal.addEventListener('abort', release, { once: true });
    instances.reconcile();
    changed(true);
    if (owner.signal.aborted) release();
    return release;
  }
  function access(suppliedOwner: WorkspaceOwner, track: (dispose: Dispose) => Dispose = (dispose) => dispose): UiAccess {
    const owner = Object.freeze({ ...suppliedOwner });
    requirePluginId(owner.pluginId);
    if (!Number.isSafeInteger(owner.generation) || owner.generation < 0) invalid('工作区所属代次无效');
    const current = () => {
      check();
      if (owner.signal.aborted) throw new HostError('cancelled', 'workspace_owner_revoked', '工作区所属作用域已撤销');
    };
    return Object.freeze<UiAccess>({
      register: (value) => { current(); return track(register(owner, value)); },
      updatePage(pageId, changes) {
        current(); requireOwnedId(owner.pluginId, pageId);
        const entry = pages.get(pageId);
        if (!entry || entry.owner !== owner) invalid('只能更新当前所属作用域登记的页面');
        const definition = updatedPageMetadata(entry.definition, changes);
        // 保留登记令牌和派生视图身份，避免清理失效、实例换代或丢失草稿。
        entry.definition = definition;
        const view = pageViews.get(pageId);
        if (view) view.definition = Object.freeze({ ...view.definition, title: definition.title });
        changed(true);
      },
      catalog: () => { current(); return catalog(); },
      snapshot: () => { current(); return snapshot(); },
      subscribe(listener) {
        current();
        const guarded = () => { if (!owner.signal.aborted) listener(); };
        listeners.add(guarded);
        const release = () => {
          listeners.delete(guarded);
          owner.signal.removeEventListener('abort', release);
        };
        owner.signal.addEventListener('abort', release, { once: true });
        return track(release);
      },
      open(input, signal) {
        current();
        for (const [workspaceId, layout] of layouts) {
          if (workspaceId !== input.workspaceId && layoutInstanceIds(layout).has(input.instanceId))
            invalid('视图实例已在其他工作区布局中保留');
        }
        const combined = signal ? AbortSignal.any([owner.signal, signal]) : owner.signal;
        if (combined.aborted) throw new HostError('cancelled', 'workspace_owner_revoked', '工作区所属作用域已撤销');
        return instances.open(input, { ...owner, signal: combined });
      },
      close(instanceId) {
        current();
        requireId(instanceId);
        instances.close(instanceId);
        for (const [workspaceId, layout] of layouts) layouts.set(workspaceId, removeFromLayout(layout, instanceId));
        changed();
      },
      setTarget: (instanceId, target) => { current(); return instances.setTarget(instanceId, target); },
      setVisible: (instanceId, visible) => { current(); return instances.setVisible(instanceId, visible); },
      selectProvider: (instanceId, provider) => { current(); return instances.selectProvider(instanceId, provider); },
      readLayout(workspaceId) { current(); requireId(workspaceId); return layouts.get(workspaceId) ?? null; },
      writeLayout(workspaceId, layout) {
        current();
        requireId(workspaceId);
        validateWorkspaceLayout(layout);
        checkInstanceWorkspace(workspaceId, layout);
        if (!layouts.has(workspaceId) && layouts.size >= 128) invalid('工作区布局数量超过限制');
        layouts.set(workspaceId, clone(layout));
        changed();
      },
    });
  }
  function save(): WorkspaceSavedState {
    check();
    return clone({ version: 1, instances: instances.save(),
      layouts: [...layouts].map(([workspaceId, layout]) => ({ workspaceId, layout })),
    });
  }
  function restore(value: unknown) {
    check();
    validateSavedState(value);
    const state = clone(value);
    batch(() => {
      instances.clear();
      layouts.clear();
      for (const entry of state.layouts) layouts.set(entry.workspaceId, entry.layout);
      for (const input of state.instances) instances.open(input, null, input.pluginId);
      changed();
    });
  }
  const host = access({ pluginId: 'host', generation: 0, signal: lifetime.signal });
  if (options.initial !== undefined) restore(options.initial);
  return {
    access, catalog, snapshot, save, restore,
    hostAccess: () => host,
    resolveView(instanceId: string) { check(); return instances.resolve(instanceId); },
    resolvePage(pageId: string) { check(); return pages.get(pageId) ?? null; },
    dispose() {
      if (closed) return;
      closed = true;
      listeners.clear();
      lifetime.abort();
      for (const release of [...releases]) release();
      instances.clear();
      pages.clear(); workspaces.clear(); views.clear(); pageViews.clear(); layouts.clear();
      catalogCache = null; snapshotCache = null;
    },
  };
}
