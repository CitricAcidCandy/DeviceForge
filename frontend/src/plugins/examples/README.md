# 任务实验扩展示例

`createTaskLab(公开操作ID)` 返回 SDK v2 插件，注册组件槽、模块、命令、服务和输入钩子。命令通过公开 HostContext 提交任务并保留服务器日志 ID；该操作的输入实际变换为 `{source:"task-lab",value:原输入}`，因此只用于接受此模式的示例操作。

可用 runtime.webPlugins.register 登记该对象并 load；宿主注入 workspace.sidebar 槽及 /task-lab 模块目标后显式 mount。没有修改现有页面或添加 UI 库。独立发布时将该函数返回值作为包默认导出并自行打包 UI 依赖，包清单/API 由在线安装契约管理。

示例声明 `wrapInput` 与 `statusLabel` 配置，通过 `HostContext.configuration` 读取。输入钩子在下次任务调用时检查开关，组件在挂载时读取标题；缺少可选配置入口的旧宿主沿用默认行为。
