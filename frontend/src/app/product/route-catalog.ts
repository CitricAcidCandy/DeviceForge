import type { Dispose, ModuleInfo, WorkspacePageInfo, WorkspaceSnapshot } from '../../plugin-sdk/index.ts';
import { localRouteKey, normalizeLocalRoute, pluginRoute, routeHash } from './route-address.ts';
import type { ProductRoute } from './route-address.ts';

export interface RouteNavigation {
  readonly group?: string;
  readonly order?: number;
  readonly icon?: string;
  readonly hidden?: boolean;
  readonly description?: string;
}
/** 元数据来自公开页面目录；过渡定义也允许测试或旧装配显式注入。 */
export interface RoutePageInput extends WorkspacePageInfo {
  readonly navigation?: RouteNavigation;
  readonly operations?: readonly string[];
  readonly taskPolicy?: 'listed' | 'all';
  readonly viewId?: string | null;
}
export interface RouteCatalogEntry {
  readonly key: ProductRoute;
  readonly id: string;
  readonly pluginId: string;
  readonly generation: number;
  readonly title: string;
  readonly label: string;
  readonly route: string;
  readonly group: string;
  readonly order: number;
  readonly icon: string | null;
  readonly hidden: boolean;
  readonly description: string;
  readonly workspaceId: string | null;
  readonly viewId: string | null;
  readonly source: 'workspace' | 'module' | 'compatibility';
  readonly operations: readonly string[];
  readonly taskPolicy: 'listed' | 'all';
}
export interface RouteCatalogDiagnostic {
  readonly code: 'invalid_route' | 'duplicate_route';
  readonly route: string;
  readonly contributions: readonly string[];
}
export interface RouteCatalogSnapshot {
  readonly revision: number;
  readonly entries: readonly RouteCatalogEntry[];
  readonly diagnostics: readonly RouteCatalogDiagnostic[];
}
export interface RouteCatalogSource<T> {
  snapshot(): T;
  subscribe(listener: () => void): Dispose;
}
export interface RouteCatalogOptions {
  readonly workspace: RouteCatalogSource<Pick<WorkspaceSnapshot, 'catalog'>>;
  readonly modules?: RouteCatalogSource<{ readonly modules: readonly ModuleInfo[] }>;
  /** 仅用于迁移期间显式注入，不作为新增业务登记清单。 */
  readonly compatibility?: readonly RoutePageInput[];
}
export interface RouteCatalog {
  snapshot(): RouteCatalogSnapshot;
  subscribe(listener: () => void): Dispose;
  dispose(): void;
}

function pageEntry(page: RoutePageInput, source: 'workspace' | 'compatibility'): RouteCatalogEntry | null {
  const route = normalizeLocalRoute(page.route);
  if (!route) return null;
  const navigation = page.navigation;
  return Object.freeze({
    key: localRouteKey(route),
    id: page.id,
    pluginId: page.pluginId,
    generation: page.generation,
    title: page.title,
    label: page.title,
    route,
    group: navigation?.group ?? '插件',
    order: navigation?.order ?? 0,
    icon: navigation?.icon ?? null,
    hidden: navigation?.hidden ?? false,
    description: navigation?.description ?? '',
    workspaceId: page.workspaceId,
    viewId: page.viewId ?? null,
    source,
    operations: Object.freeze([...new Set(page.operations ?? [])]),
    taskPolicy: page.taskPolicy ?? 'listed',
  });
}
function moduleEntry(module: ModuleInfo): RouteCatalogEntry {
  return Object.freeze({
    key: pluginRoute(module.pluginId, module.route),
    id: module.id,
    pluginId: module.pluginId,
    generation: module.generation,
    title: module.title,
    label: module.title,
    route: `/${routeHash(pluginRoute(module.pluginId, module.route))}`,
    group: '插件',
    order: 0,
    icon: null,
    hidden: false,
    description: '',
    workspaceId: null,
    viewId: null,
    source: 'module',
    operations: Object.freeze([]),
    taskPolicy: 'listed',
  });
}

/** 只订阅注入的数据源，不依赖插件管理器或产品服务工厂。 */
export function createRouteCatalog(options: RouteCatalogOptions): RouteCatalog {
  let revision = 0;
  const read = () => buildRouteCatalog(
    options.workspace.snapshot().catalog.pages,
    options.modules?.snapshot().modules ?? [],
    options.compatibility ?? [],
    revision,
  );
  let current = read();
  let signature = JSON.stringify([current.entries, current.diagnostics]);
  let disposed = false;
  const listeners = new Set<() => void>();
  const releases: Dispose[] = [];
  const refresh = () => {
    if (disposed) return;
    const next = read();
    const nextSignature = JSON.stringify([next.entries, next.diagnostics]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    revision++;
    current = Object.freeze({ ...next, revision });
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个消费方不能中断目录发布。 */ }
    }
  };
  try {
    releases.push(options.workspace.subscribe(refresh));
    if (options.modules) releases.push(options.modules.subscribe(refresh));
    refresh();
  } catch (error) {
    disposed = true;
    for (const release of releases.reverse()) {
      try { release(); } catch { /* 初始化失败时继续回收其余已归属订阅，保留原始错误。 */ }
    }
    throw error;
  }
  return {
    snapshot: () => current,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      const errors: unknown[] = [];
      for (const release of releases.reverse()) {
        try { release(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, '路由目录订阅回收失败');
    },
  };
}
function identity(entry: Pick<RouteCatalogEntry, 'pluginId' | 'id'>): string {
  return `${entry.pluginId}:${entry.id}`;
}
function ordered(first: RouteCatalogEntry, second: RouteCatalogEntry): number {
  return first.order - second.order || first.key.localeCompare(second.key) || identity(first).localeCompare(identity(second));
}

/** 同一路由的多个实际提供者全部退出可用目录，避免加载顺序隐式抢占。 */
export function buildRouteCatalog(
  pages: readonly RoutePageInput[],
  modules: readonly ModuleInfo[] = [],
  compatibility: readonly RoutePageInput[] = [],
  revision = 0,
): RouteCatalogSnapshot {
  const diagnostics: RouteCatalogDiagnostic[] = [];
  const candidates: RouteCatalogEntry[] = [];
  for (const page of pages) {
    const entry = pageEntry(page, 'workspace');
    if (entry) candidates.push(entry);
    else diagnostics.push(Object.freeze({
      code: 'invalid_route', route: page.route, contributions: Object.freeze([identity(page)]),
    }));
  }
  // 同一旧模块已由原注册层派生成工作区页面时只保留一次；不同身份仍报告冲突。
  candidates.push(...modules.filter((module) => !pages.some((page) =>
    page.pluginId === module.pluginId && page.id === module.id &&
    page.generation === module.generation && page.viewId === module.id &&
    page.route === moduleEntry(module).route)).map(moduleEntry));
  const occupied = new Set(candidates.map((entry) => entry.key));
  for (const page of compatibility) {
    const entry = pageEntry(page, 'compatibility');
    if (entry && !occupied.has(entry.key)) candidates.push(entry);
  }
  const byRoute = new Map<ProductRoute, RouteCatalogEntry[]>();
  for (const entry of candidates) {
    const current = byRoute.get(entry.key) ?? [];
    current.push(entry);
    byRoute.set(entry.key, current);
  }
  const entries: RouteCatalogEntry[] = [];
  for (const [route, providers] of byRoute) {
    if (providers.length === 1 && providers[0]) entries.push(providers[0]);
    else diagnostics.push(Object.freeze({
      code: 'duplicate_route',
      route,
      contributions: Object.freeze(providers.map(identity).sort()),
    }));
  }
  return Object.freeze({
    revision,
    entries: Object.freeze(entries.sort(ordered)),
    diagnostics: Object.freeze(diagnostics.sort((first, second) => first.route.localeCompare(second.route))),
  });
}
