# MCP 目录消费

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。
- `infrastructure/`：宿主网关、字节流解码、媒体与浏览器适配；依赖纯规则和模型。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

本模块消费 MCP 协议 `2026-07-28` 的工具目录与目录主动通知。`createMcpClient` 通过注入的传输读取 `tools/list` 分页，并订阅 `subscriptions/listen` 的 SSE；收到 `notifications/tools/list_changed` 后重新读取全部目录。

模块只负责协议解码、目录快照和订阅生命周期，不创建产品页面、不执行 MCP 工具，也不替代前端 HTTP 操作目录。传输适配位于 `shared/api/mcp.ts`，运行实例通过 `runtime.mcp` 暴露；真实 MCP 客户端互操作仍需独立验收。
