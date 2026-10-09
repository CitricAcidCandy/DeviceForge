# HTTP 服务与 MCP 入口

作用：装配路由、鉴权、限流、OpenAPI 和 MCP 协议。适用于服务器部署与协议契约验证。

快速开始：配置 `APK_API_TOKEN` 后在后端目录执行 `cargo run -p apk-server`。默认地址 `127.0.0.1:7031`。执行 `cargo test -p apk-server` 验证 HTTP 与 MCP。

API：`router(app, token, requests_per_second)` 使用默认 MCP 安全配置；`router_with_mcp` 允许部署者传入 SDK 配置；`openapi_document` 导出从 Rust 结构生成的公开接口；`mcp::default_config` 提供无会话 JSON 响应方式。HTTP 推荐 `/api/v2`，保留 v1 兼容；MCP 在 `/mcp`。MCP 请求的协议解析由官方 SDK 负责。

默认全局每秒请求上限为 120，`DEVICEFORGE_HTTP_RATE` 可在 1–100000 调整；最多 128 个在途响应，HTTP 与 MCP 共用限流和访问令牌。请求许可随响应流结束、错误或断开释放。生产部署建议反向代理配置 TLS、独立用户认证与入口限流；当前令牌代表共享部署身份，不是多租户权限系统。业务错误统一转换，底层部署错误不直接返回客户端。

最外层 correlation 生成可信 UUID，v2 业务成功/失败返回日志 ID，原始产物不改字节；MCP 装饰器传播任务上下文并写标准元数据。response_stream 记录响应结束与字节数。完整契约见后端日志文档。`router_with_runtime` 注入日志统计与停止令牌；这两个管理入口均鉴权。

产物服务：router_with_artifacts 注入领域 ArtifactStore。启动程序默认装配文件适配器，提供上传、元数据、流式下载和 ZIP 目录预览；未注入存储时产物接口返回 503。详见 docs/产物接口.md。

## 动态目录与管理边界

plugin_routes.rs 只转换鉴权后的插件 ID 请求，并调用 RuntimeServices.plugins 注入的 PluginService。GET /api/v2/plugins 和 POST /api/v2/plugins/{id}/load、/unload 沿用日志包装；未注入返回 503，不在路由读取清单或执行注册规则。

mcp_tools.rs 将当前操作快照转换为工具，追加任务管理与可选插件管理工具。mcp.rs 使用目录修订验证分页游标，工具调用查当前单项贡献；目录变化后旧游标失效，客户端重新发现，不宣称推送通知。main.rs 装配部署目录、初始所有权与性能保护依赖；退出先关闭管理准入再收敛任务和管理工作。
# 离线插件安装门禁

bin/validate-plugin.rs 接收单一管理员清单，限制 64 KiB，使用 ProcessPlugin 与 application::registration 以及可选性能探针契约校验；仅检查入口、协议与模式，不监听 HTTP、不连接设备、不运行插件。标准输出为 id/version/operations 概要，失败使用固定中文诊断，避免原始路径或不可信数据输出。

