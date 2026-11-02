import {
  Smartphone,
  FolderOpen,
  Activity,
  Code2,
  Workflow,
  Terminal,
  Sparkles,
  ScanSearch,
  ListChecks,
  Settings2,
  Store,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isPluginRoute, normalizeLocalRoute, pluginRoute, routeHash, splitPluginRoute } from './route-address.ts';
import type { LocalRoute, ProductRoute } from './route-address.ts';
import { LEGACY_ROUTE_DEFINITIONS } from './legacy-route-definitions.ts';
import type { HostRoute } from './legacy-route-definitions.ts';

// 此入口只保留旧UI的图标和默认回落；正常平台使用不加载业务目录的route-address。
export { isPluginRoute, normalizeLocalRoute, pluginRoute, routeHash, splitPluginRoute } from './route-address.ts';
export type { LocalRoute, PluginRoute, ProductRoute } from './route-address.ts';
export type { HostRoute } from './legacy-route-definitions.ts';

export interface ProductRouteInfo {
  readonly id: HostRoute;
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly icon: LucideIcon;
  // 不进侧栏，只能由其它页面（如设置）的入口进入；路由本身仍然有效。
  readonly hidden?: boolean;
}
const legacyIcons: Readonly<Record<HostRoute, LucideIcon>> = {
  devices: Smartphone, files: FolderOpen, performance: Activity, frida: Code2,
  automation: Workflow, terminal: Terminal, ai: Sparkles, analysis: ScanSearch,
  tasks: ListChecks, marketplace: Store, settings: Settings2,
};
export const PRODUCT_ROUTES: readonly ProductRouteInfo[] = LEGACY_ROUTE_DEFINITIONS.map((entry) => ({
  ...entry, icon: legacyIcons[entry.id],
}));
const hostIndex = new Map<string, ProductRouteInfo>(PRODUCT_ROUTES.map((item) => [item.id, item]));

export function hostRouteInfo(route: string): ProductRouteInfo | null {
  return hostIndex.get(route) ?? null;
}
/** 旧UI仍只把历史11页面转换成裸键，保留原有调用行为。 */
export function localRouteKey(path: LocalRoute): ProductRoute {
  const name = path.slice(1);
  const legacy = hostIndex.get(name);
  if (legacy) return legacy.id;
  const plugin = /^plugin\/([^/]+)\/(.+)$/.exec(name);
  if (plugin) return pluginRoute(plugin[1] ?? '', plugin[2] ?? '');
  return path;
}
export function parseProductRoute(
  value: string,
  routes?: readonly { readonly key: ProductRoute }[],
  preserveUnknown = false,
): ProductRoute {
  const route = value.replace(/^#\/?/, '').split('?', 1)[0];
  if (!route) return routes?.some((entry) => entry.key === '/') ? '/' : 'devices';
  if (isPluginRoute(route)) {
    const { pluginId, page } = splitPluginRoute(route);
    return pluginRoute(pluginId, page);
  }
  const path = normalizeLocalRoute(`/${route.replace(/^\//, '')}`);
  if (!path) return 'devices';
  const plugin = /^plugin\/([^/]+)\/(.+)$/.exec(route);
  if (plugin) return pluginRoute(plugin[1] ?? '', plugin[2] ?? '');
  const key = localRouteKey(path);
  const registered = routes?.find((entry) => routeHash(entry.key) === routeHash(key));
  if (registered) return registered.key;
  if (!key.startsWith('/') || preserveUnknown || routes?.some((entry) => entry.key === key)) return key;
  return 'devices';
}
// 侧栏与状态栏只数可见路由；隐藏路由仍可直达。
export const VISIBLE_ROUTES = PRODUCT_ROUTES.filter((entry) => !entry.hidden);
