# MCP 目录消费契约

前端通过 `runtime.mcp` 消费 MCP 协议 `2026-07-28` 的工具目录。客户端向同源 `/mcp` 发送 POST JSON-RPC 请求，使用 `MCP-Protocol-Version`、`Mcp-Method`、可选 `Authorization` 和标准客户端元数据；令牌不进入 URL 或本地存储。

`listTools` 会沿 `nextCursor` 读取全部页面。每页最多 100 项，游标包含服务器目录修订；目录响应接受标准 `resultType: "complete"`，缺省值兼容旧响应，其他结果类型严格拒绝。游标重复、身份错误、未知字段、日志 ID 不一致和非法工具模式都会拒绝整次目录。工具及输入模式建立冻结快照，响应日志优先保留 `x-deviceforge-log-id`，并校验成功元数据中的 `deviceforge/log_id`。

`subscribe` 发送 `notifications.toolsListChanged=true`，要求首帧确认 `notifications/subscriptions/acknowledged`，随后只接受 `notifications/tools/list_changed`。通知不携带工具数据，客户端会重新执行 `tools/list`；连续通知按订阅内队列合并等待。订阅关闭、调用者取消、运行实例销毁和忽略信号的晚到响应均不得发布旧快照。

本模块只消费目录和通知，不执行 MCP 工具、不创建产品页面，也不把 MCP 目录与 HTTP `operations` 目录混合。当前测试为注入传输和真实协议形状回归；真实 MCP 客户端互操作、网络来源授权和产品 UI 仍需独立验收。
