# 业务功能边界

已实现 operations/tasks/server-plugins 的无界面基础用例；各模块在 index.ts 公开入口，app 注入跨模块协作回调，不跨功能内部导入。

operations 管理目录，tasks 管理任务/事件并调用注入任务钩子，server-plugins 串行变更与重新查询。共享最新资源处理选择/刷新晚到结果。在线包功能待后端生成契约再追加；设备提供者不在当前范围。
