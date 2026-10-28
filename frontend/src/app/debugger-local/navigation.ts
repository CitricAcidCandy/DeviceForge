import type { LocalDebuggerOptions, HostDebugRoute } from './types.ts';
import { bounded, fail, text } from './validation.ts';

export function readHostRoutes(options: LocalDebuggerOptions): readonly HostDebugRoute[] {
  const routes = options.readHostRoutes?.() ?? [];
  if (routes.length > 256) return fail('limit_exceeded', '公开宿主路由最多256项');
  const paths = new Set<string>();
  return routes.map((route) => {
    const path = text(route.path, '路由路径');
    if (!/^\/(?!\/)[^?#\\%]*$/.test(path) || path.split('/').some((part) => part === '.' || part === '..') || paths.has(path))
      return fail('invalid_parameters', '公开路由必须是唯一、无查询参数的规范本地路径');
    paths.add(path);
    if ((route.slotIds?.length ?? 0) > 128) return fail('limit_exceeded', '单个路由的公开槽位最多128项');
    return { path, label: text(route.label, '路由名称'), ...(route.slotIds ? { slotIds: route.slotIds.map((id) => text(id, '槽位标识')) } : {}) };
  });
}
export async function navigate(options: LocalDebuggerOptions, path: string, confirmed: boolean, signal: AbortSignal) {
  const callback = options.navigate;
  if (!confirmed || !callback || !readHostRoutes(options).some((route) => route.path === path))
    return fail('capability_unavailable', '导航需要显式确认、公开路由目录和已注入的宿主导航回调');
  const current = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  await bounded(() => Promise.resolve(callback(path, current)), current, true);
  return { status: 'dispatched', target: null, businessOutcome: 'unknown', reason: '已派发公开导航；页面实例化与业务结果尚未确认' };
}
