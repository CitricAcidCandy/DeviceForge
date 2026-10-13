# MCP 目录消费

本模块消费 MCP 协议 `2026-07-28` 的工具目录与目录主动通知。`createMcpClient` 通过注入的传输读取 `tools/list` 分页，并订阅 `subscriptions/listen` 的 SSE；收到 `notifications/tools/list_changed` 后重新读取全部目录。

模块只负责协议解码、目录快照和订阅生命周期，不创建产品页面、不执行 MCP 工具，也不替代前端 HTTP 操作目录。传输适配位于 `shared/api/mcp.ts`，运行实例通过 `runtime.mcp` 暴露；真实 MCP 客户端互操作仍需独立验收。
