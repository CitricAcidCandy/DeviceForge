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
import { slotKey } from '../../plugin-sdk/slots.ts';

// 画面与录制、应用与包已并入设备工作台，作为该页的两个模式，不再单列路由。
// 插件装载与工具供应已并入市场：市场同时承担检索、安装、启用与卸载，不再有独立页面。
export type HostRoute =
  | 'devices'
  | 'files'
  | 'performance'
  | 'frida'
  | 'automation'
  | 'terminal'
  | 'ai'
  | 'analysis'
  | 'tasks'
  | 'marketplace'
  | 'settings';
/**
 * 插件页面路由：内部键 `plugin:<pluginId>:<page>`，地址栏写成 `#/plugin/<pluginId>/<page>`。
 * 用内部键而不是路径原文，是为了让「当前页面」在状态里仍然是一个可比较的字符串，
 * 路由、导航、槽位派生三处不用各自再解析一遍路径。
 */
export type PluginRoute = `plugin:${string}:${string}`;
export type ProductRoute = HostRoute | PluginRoute;

export interface ProductRouteInfo {
  readonly id: HostRoute;
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly icon: LucideIcon;
  // 不进侧栏，只能由其它页面（如设置）的入口进入；路由本身仍然有效。
  readonly hidden?: boolean;
}
export const PRODUCT_ROUTES: readonly ProductRouteInfo[] = [
  {
    id: 'devices',
    label: '设备',
    group: '工作台',
    description: '连接设备，在同一个工作台里看画面、管理应用与安装包',
    icon: Smartphone,
  },
  {
    id: 'files',
    label: '文件与产物',
    group: '工作台',
    description: '按产物 ID 取用服务器产物，预览与下载真实文件',
    icon: FolderOpen,
    hidden: true,
  },
  {
    id: 'performance',
    label: '性能与调用栈',
    group: '深度调试',
    description: '指标、采样画面与 Root 调用栈关联',
    icon: Activity,
  },
  {
    id: 'frida',
    label: 'Frida',
    group: '深度调试',
    description: '运行时检查、脚本与权限分析',
    icon: Code2,
  },
  {
    id: 'automation',
    label: '自动化',
    group: '深度调试',
    description: '流程、重复点击与桌面控制',
    icon: Workflow,
  },
  {
    id: 'terminal',
    label: '终端',
    group: '深度调试',
    description: '有状态终端与保留输出',
    icon: Terminal,
  },
  {
    id: 'ai',
    label: 'AI 助手',
    group: '扩展创作',
    description: 'CLI 与 SDK 会话、实时回答',
    icon: Sparkles,
  },
  {
    id: 'analysis',
    label: '数据分析',
    group: '扩展创作',
    description: 'DEX 与 MessagePack 数据检查',
    icon: ScanSearch,
  },
  {
    id: 'tasks',
    label: '任务与日志',
    group: '工坊',
    description: '任务历史、取消、结果与排查线索',
    icon: ListChecks,
  },
  {
    id: 'marketplace',
    label: '市场',
    group: '工坊',
    description: '检索、安装、启用与卸载插件、工具、配置与分发资源',
    icon: Store,
  },
  {
    id: 'settings',
    label: '设置',
    group: '工坊',
    description: '配置、主题与运行偏好',
    icon: Settings2,
  },
];
const hostIndex = new Map<string, ProductRouteInfo>(PRODUCT_ROUTES.map((item) => [item.id, item]));

export function pluginRoute(pluginId: string, page: string): PluginRoute {
  return `plugin:${slotKey(pluginId)}:${slotKey(page)}`;
}
export function isPluginRoute(route: string): route is PluginRoute {
  return /^plugin:[^:]+:/.test(route);
}
export function splitPluginRoute(route: PluginRoute): { pluginId: string; page: string } {
  const [, pluginId = '', ...rest] = route.split(':');
  return { pluginId, page: rest.join(':') };
}
export function hostRouteInfo(route: string): ProductRouteInfo | null {
  return hostIndex.get(route) ?? null;
}
/** 地址栏里的写法：宿主路由保持原样，插件页面写成 plugin/<pluginId>/<page>（不含 `#`）。 */
export function routeHash(route: ProductRoute): string {
  if (!isPluginRoute(route)) return route;
  const { pluginId, page } = splitPluginRoute(route);
  return `plugin/${pluginId}/${page}`;
}
export function parseProductRoute(value: string): ProductRoute {
  const route = value.replace(/^#\/?/, '').split('?', 1)[0];
  if (!route) return 'devices';
  const plugin = /^plugin\/([^/]+)\/(.+)$/.exec(route);
  if (plugin) return pluginRoute(plugin[1] ?? '', plugin[2] ?? '');
  return hostIndex.has(route) ? (route as HostRoute) : 'devices';
}
// 侧栏与状态栏只数可见路由；隐藏路由仍可直达。
export const VISIBLE_ROUTES = PRODUCT_ROUTES.filter((entry) => !entry.hidden);
