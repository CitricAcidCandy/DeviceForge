# MCP 工具目录通知适配

本模块将用例层发布的目录修订转换为现代 MCP `subscriptions/listen` 流中的 `notifications/tools/list_changed`。同一个服务实例共享 32 个订阅许可，发送等待最多 5 秒；取消、断开和服务退出释放订阅，不自行启动后台任务。

首次发送用于覆盖发现与订阅之间的变化，之后使用 watch 最新值合并更新。日志关联由 MCP 装饰器传播，通知元数据同时携带宿主日志 ID 和 SDK 添加的标准订阅 ID。公开契约与阶段边界见 `backend/docs/implementation/MCP目录通知实施.md`。
