import type { LocalDebuggerOptions, ResolvedTarget } from './types.ts';
import { readHostRoutes } from './navigation.ts';
import { integer, json, keys } from './validation.ts';

export function publicOverview(options: LocalDebuggerOptions, target: ResolvedTarget, slotCatalog: unknown,
  mounts: unknown, input: Record<string, unknown>) {
  keys(input, ['view', 'offset', 'limit']);
  const offset = input.offset === undefined ? 0 : integer(input.offset, '目录偏移', 0, 10000);
  const limit = input.limit === undefined ? 500 : integer(input.limit, '目录页条数', 1, 500);
  const routes = readHostRoutes(options);
  const slots = json(slotCatalog);
  const mountCatalog = json(mounts);
  const slotNodes = Array.isArray(slots) ? slots : [];
  const nodes = [
    ...slotNodes.map((slot) => ({ kind: 'slot', catalog: slot })),
    ...routes.map((route) => ({ kind: 'route', catalog: { ...route, instantiated: 'unknown' } })),
    ...(Array.isArray(mountCatalog) ? mountCatalog : []).map((mount) => ({ kind: 'mount', catalog: mount })),
  ];
  return { status: 'catalog', target, source: 'host-public-catalog', completeness: 'catalog-only',
    nodes: nodes.slice(offset, offset + limit),
    page: { offset, limit, nextOffset: offset + limit < nodes.length ? offset + limit : null, total: nodes.length },
    coverage: '全部已公开宿主槽位与路由、所选插件贡献；未实例化项只表示公开目录事实，不是DOM或React树',
    limitations: ['目录页为调用时事实，分页期间目录可能变化', '不读取其他插件内部、框架状态或未挂载页面内容'] };
}
