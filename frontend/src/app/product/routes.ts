import { Smartphone, PackageOpen, FolderOpen, MonitorPlay, Activity, Code2, Workflow, Terminal, Sparkles, ScanSearch, Puzzle, ListChecks, Settings2, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type ProductRoute = 'devices' | 'packages' | 'files' | 'media' | 'performance' | 'frida' | 'automation' | 'terminal' | 'ai' | 'analysis' | 'plugins' | 'tasks' | 'tools' | 'settings';
export interface ProductRouteInfo { readonly id: ProductRoute; readonly label: string; readonly group: string; readonly description: string; readonly icon: LucideIcon }
export const PRODUCT_ROUTES: readonly ProductRouteInfo[] = [
  { id: 'devices', label: '设备', group: '工作台', description: '连接设备，按公开能力完成应用与设备操作', icon: Smartphone },
  { id: 'packages', label: '应用与包', group: '工作台', description: '上传、检查、解码与构建应用包', icon: PackageOpen },
  { id: 'files', label: '文件与产物', group: '工作台', description: '管理服务器产物，预览与下载真实文件', icon: FolderOpen },
  { id: 'media', label: '画面与录制', group: '工作台', description: '截图、实时投屏与有界录像', icon: MonitorPlay },
  { id: 'performance', label: '性能与调用栈', group: '深度调试', description: '指标、采样画面与 Root 调用栈关联', icon: Activity },
  { id: 'frida', label: 'Frida', group: '深度调试', description: '运行时检查、脚本与权限分析', icon: Code2 },
  { id: 'automation', label: '自动化', group: '深度调试', description: '流程、重复点击与桌面控制', icon: Workflow },
  { id: 'terminal', label: '终端', group: '深度调试', description: '有状态终端与保留输出', icon: Terminal },
  { id: 'ai', label: 'AI 助手', group: '扩展创作', description: 'CLI 与 SDK 会话、实时回答', icon: Sparkles },
  { id: 'analysis', label: '数据分析', group: '扩展创作', description: 'DEX、MessagePack 与表格数据', icon: ScanSearch },
  { id: 'plugins', label: '插件', group: '工坊', description: '在线安装、加载与撤销两类插件', icon: Puzzle },
  { id: 'tasks', label: '任务与日志', group: '工坊', description: '任务历史、取消、结果与排查线索', icon: ListChecks },
  { id: 'tools', label: '工具供应', group: '工坊', description: '所需运行工具的计划、安装与移除', icon: Wrench },
  { id: 'settings', label: '设置', group: '工坊', description: '配置、主题与运行偏好', icon: Settings2 },
];
export function parseProductRoute(value: string): ProductRoute {
  return PRODUCT_ROUTES.find((route) => route.id === value.replace(/^#\/?/, ''))?.id ?? 'devices';
}
