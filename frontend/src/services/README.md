# 公共服务层

公共 HTTP 客户端、接口描述、请求验证、生成类型和跨业务 API 放在 `api/`。页面及功能通过 `api/index.ts` 的公开接口使用。请求适配保留 AbortSignal、日志 ID、结构化错误和原字节产物语义。

某个功能独有的请求适配仍归该功能的 `features/<功能>/services/`，由功能的核心入口对外暴露。公共服务不导入页面或展示组件。

`api/generated.ts` 由 `npm run generate:api` 从 Rust 模式生成，不手改。
