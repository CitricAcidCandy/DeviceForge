import { pluginSlotKey, slotKey } from '../../plugin-sdk/slots.ts';

/** 地址键属于公开页面提供者，不依赖宿主业务联合或导航元数据。 */
export type ProductRoute = string;
export type PluginRoute = `plugin:${string}:${string}`;
export type LocalRoute = `/${string}`;

export function pluginRoute(pluginId: string, page: string): PluginRoute {
  return `plugin:${pluginSlotKey(pluginId)}:${slotKey(page)}`;
}
export function isPluginRoute(route: string): route is PluginRoute {
  return /^plugin:[^:]+:/.test(route);
}
export function splitPluginRoute(route: PluginRoute): { pluginId: string; page: string } {
  const [, pluginId = '', ...rest] = route.split(':');
  return { pluginId, page: rest.join(':') };
}
/** 注册与地址解析共用本地路径规则，不允许外链、穿越或编码后的分隔符。 */
export function normalizeLocalRoute(value: string): LocalRoute | null {
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 2048 || /[?#\\\u0000-\u0020\u007f]/.test(value))
    return null;
  const path = value.length > 1 ? value.replace(/\/+$/, '') : value;
  const segments = path.slice(1).split('/');
  if (path !== '/' && segments.some((segment) => !segment)) return null;
  for (const segment of segments) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    if (decoded === '.' || decoded === '..' || /[/?#\\:\u0000-\u0020\u007f]/.test(decoded) || /%[0-9a-f]{2}/i.test(decoded))
      return null;
  }
  return `/${path.slice(1)}`;
}
/** 单段地址沿用裸键，嵌套地址保留完整路径；所有页面共用规则，不查业务清单。 */
export function localRouteKey(path: LocalRoute): ProductRoute {
  const name = path.slice(1);
  const plugin = /^plugin\/([^/]+)\/(.+)$/.exec(name);
  if (plugin) return pluginRoute(plugin[1] ?? '', plugin[2] ?? '');
  return name && !name.includes('/') ? name : path;
}
/** 返回不含 # 的地址，派生模块继续使用 plugin/<pluginId>/<page>。 */
export function routeHash(route: ProductRoute): string {
  if (route.startsWith('/')) return route.slice(1);
  if (!isPluginRoute(route)) return route;
  const { pluginId, page } = splitPluginRoute(route);
  return `plugin/${pluginId}/${page}`;
}
/** 未就绪或已卸载页面默认保留地址；空地址和非法地址交给平台根页恢复。 */
export function parseProductRoute(
  value: string,
  routes?: readonly { readonly key: ProductRoute }[],
  preserveUnknown = true,
): ProductRoute {
  const route = value.replace(/^#\/?/, '').split('?', 1)[0];
  if (!route) return '/';
  if (isPluginRoute(route)) {
    const { pluginId, page } = splitPluginRoute(route);
    return pluginRoute(pluginId, page);
  }
  const path = normalizeLocalRoute(`/${route.replace(/^\//, '')}`);
  if (!path) return '/';
  const key = localRouteKey(path);
  const registered = routes?.find((entry) => routeHash(entry.key) === routeHash(key));
  return registered?.key ?? (preserveUnknown ? key : '/');
}
