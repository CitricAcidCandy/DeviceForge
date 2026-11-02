/** 仅供旧UI和旧具名槽位兼容，不作为正常平台新增业务的登记入口。 */
export const LEGACY_ROUTE_DEFINITIONS = [
  {
    id: 'devices', label: '设备', group: '工作台',
    description: '连接设备，在同一个工作台里看画面、管理应用与安装包',
  },
  {
    id: 'files', label: '文件与产物', group: '工作台',
    description: '按产物 ID 取用服务器产物，预览与下载真实文件', hidden: true,
  },
  {
    id: 'performance', label: '性能与调用栈', group: '深度调试',
    description: '指标、采样画面与 Root 调用栈关联',
  },
  {
    id: 'frida', label: 'Frida', group: '深度调试',
    description: '运行时检查、脚本与权限分析',
  },
  {
    id: 'automation', label: '自动化', group: '深度调试',
    description: '流程、重复点击与桌面控制',
  },
  {
    id: 'terminal', label: '终端', group: '深度调试',
    description: '有状态终端与保留输出',
  },
  {
    id: 'ai', label: 'AI 助手', group: '扩展创作',
    description: 'CLI 与 SDK 会话、实时回答',
  },
  {
    id: 'analysis', label: '数据分析', group: '扩展创作',
    description: 'DEX 与 MessagePack 数据检查',
  },
  {
    id: 'tasks', label: '任务与日志', group: '工坊',
    description: '任务历史、取消、结果与排查线索',
  },
  {
    id: 'marketplace', label: '市场', group: '工坊',
    description: '检索、安装、启用与卸载插件、工具、配置与分发资源',
  },
  {
    id: 'settings', label: '设置', group: '工坊',
    description: '配置、主题与运行偏好',
  },
] as const;

export type HostRoute = (typeof LEGACY_ROUTE_DEFINITIONS)[number]['id'];
