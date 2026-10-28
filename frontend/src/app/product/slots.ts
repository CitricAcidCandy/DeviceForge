import { pageSlotId } from '../../plugin-sdk/slots.ts';
import { PRODUCT_ROUTES, isPluginRoute, splitPluginRoute } from './routes.ts';
import type { HostRoute, ProductRoute } from './routes.ts';

export type SlotModeName = 'append' | 'replace';
export interface HostSlot {
  readonly id: string;
  readonly label: string;
  readonly route: HostRoute | null;
  readonly modes: readonly SlotModeName[];
  readonly description: string;
}

const bothModes: readonly SlotModeName[] = ['append', 'replace'];
/**
 * 市场页是卸载与禁用插件的唯一自救入口，设置页保留宿主参数与主题入口。
 * 这两页只允许插件追加，不允许替换；设置页另有专属区域承载插件自己的设置分组。
 */
const appendOnlyRoutes: ReadonlySet<HostRoute> = new Set<HostRoute>(['marketplace', 'settings']);

/** 插件贡献的页面：由 module 元数据派生，宿主侧只定义、不预置内容。 */
export { pageSlotId } from '../../plugin-sdk/slots.ts';
/** 路由到槽位：宿主路由落到 `route.<id>`，插件页面落到它派生出来的 `page.<pluginId>.<page>`。 */
export function routeSlotId(route: ProductRoute): string {
  if (!isPluginRoute(route)) return `route.${route}`;
  const { pluginId, page } = splitPluginRoute(route);
  return pageSlotId(pluginId, page);
}

const routeSlots: readonly HostSlot[] = PRODUCT_ROUTES.map((entry) => ({
  id: `route.${entry.id}`,
  label: entry.label,
  route: entry.id,
  modes: appendOnlyRoutes.has(entry.id) ? (['append'] as const) : bothModes,
  description: appendOnlyRoutes.has(entry.id)
    ? `整页追加挂载点（受保护，不允许替换）：${entry.description}`
    : `整页替换挂载点：${entry.description}`,
}));

const areaSlots: readonly HostSlot[] = [
  {
    id: 'developer.tools',
    label: '开发者工具',
    route: null,
    modes: ['append'],
    description: '业务路由之外的开发工具挂载区域，仅允许追加；不代表任意界面节点均可嵌入。',
  },
  {
    id: 'devices.apps',
    label: '设备应用面',
    route: 'devices',
    modes: bothModes,
    description: '设备工作台右栏「应用」页签的内部区域，可被插件整块替换。',
  },
  {
    id: 'settings.plugin.section',
    label: '设置 · 插件分组',
    route: 'settings',
    modes: ['append'],
    description: '设置页末尾的追加区域，插件在此放入自己的设置分组。',
  },
];

/** 宿主开放的全部具名槽位；插件写错名字时靠它做静态对账。 */
export const HOST_SLOTS: readonly HostSlot[] = [...routeSlots, ...areaSlots];
const index = new Map<string, HostSlot>(HOST_SLOTS.map((slot) => [slot.id, slot]));

export function hostSlot(id: string): HostSlot | null {
  return index.get(id) ?? null;
}
/** 插件页面槽位不登记在清单里，但同样合法；其它未登记的槽位视为写错。 */
export function isKnownSlot(id: string): boolean {
  return index.has(id) || /^page\.[a-z][a-z0-9._-]{0,99}\.[a-z][a-z0-9._-]{0,63}$/.test(id);
}
export function slotModes(id: string): readonly SlotModeName[] {
  return index.get(id)?.modes ?? (id.startsWith('page.') ? (['replace'] as const) : bothModes);
}

export const ROUTE_SLOT_IDS: readonly string[] = routeSlots.map((slot) => slot.id);
