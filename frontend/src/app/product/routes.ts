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

// 画面与录制、应用与包已并入设备工作台，作为该页的两个模式，不再单列路由。
// 插件装载与工具供应已并入市场：市场同时承担检索、安装、启用与卸载，不再有独立页面。
export type ProductRoute =
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
export interface ProductRouteInfo {
  readonly id: ProductRoute;
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
export function parseProductRoute(value: string): ProductRoute {
  const route = value.replace(/^#\/?/, '').split('?', 1)[0];
  return PRODUCT_ROUTES.find((item) => item.id === route)?.id ?? 'devices';
}
// 侧栏与状态栏只数可见路由；隐藏路由仍可直达。
export const VISIBLE_ROUTES = PRODUCT_ROUTES.filter((entry) => !entry.hidden);
