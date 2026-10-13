# MCP 服务

## 接入
服务器在 `/mcp` 提供 Streamable HTTP，使用官方 Rust SDK `rmcp`，与 HTTP API 共用应用实例、任务库和可选鉴权。默认只需配置服务地址；设置 APK_API_TOKEN 后客户端提供 `Authorization` 请求头，不把访问令牌放入 URL。不实现 OAuth 授权发现。

默认使用无会话 JSON 响应，协议协商、请求解析和格式检查由 SDK 负责。测试覆盖 2026-07-28 协议工具请求。SDK 也支持旧协议初始化兼容，后续需增加具体客户端的互操作测试。

## 工具
全部运行时操作贡献作为同名工具注册，包括服务器插件。工具输入模式直接复用操作模式，提交返回任务 ID 和排队状态。工具调用成功只证明任务已提交；必须读取最终状态判断设备动作是否成功。

额外管理工具：`deviceforge.list_operations` 不接收参数；`deviceforge.get_job` 和 `deviceforge.cancel_job` 接收 `id`；`deviceforge.job_events` 接收 `id` 与可选 `after`。工具发现按 100 条分页，返回游标。错误通过工具结果的 `isError` 和结构化错误报告。

装配插件管理服务后另贡献 `deviceforge.list_plugins`（空对象）、`deviceforge.load_plugin` 和 `deviceforge.unload_plugin`（`{"id":"echo"}`）。它们与 HTTP 管理入口共用异步生命周期，成功直接返回 PluginInfo，不创建业务任务。只能管理部署根内已发布的插件，不接受路径或清单；受保护依赖拒绝卸载。加载/卸载错误同样具有请求日志 ID。

工具发现每次读取当前目录，缓存时间为 0；分页游标包含目录修订。加载或撤销贡献后旧游标返回 invalid_params，客户端须从第一页重新发现。协议 `2026-07-28` 现在通过 `subscriptions/listen` 的 POST SSE 流支持 `notifications/tools/list_changed`，请求 `notifications:{toolsListChanged:true}` 并携带该协议的标准请求元数据；普通请求继续使用无会话 JSON。订阅先发送一次失效通知，之后在贡献成功发布或首次撤销时通知，客户端重新发现目录。旧协议继续显式刷新，不提供旧会话 GET SSE。卸载后的工具调用不能使用旧目录继续提交；资源、关联和验证边界见 [MCP目录通知实施](MCP目录通知实施.md)。

MCP 请求取消和业务任务取消是不同生命周期；中止设备操作应显式调用 cancel_job。HTTP 和 MCP 返回同一任务 ID，可交叉查询。

所有 HTTP 传输响应携带可信 `x-deviceforge-log-id`。成功结果在 `result._meta["deviceforge/log_id"]` 返回关联 ID，包括初始化、工具发现、调用和 ping；JSON-RPC 错误在 `error.data.log_id` 返回。HTTP 鉴权或传输拒绝使用安全诊断体，不伪造协议请求 ID。后台业务任务继承提交请求日志 ID；后续查询产生新 ID，按任务 ID 串联。详见 [日志与关联契约](日志与关联契约.md)。

## 部署参数
默认 Host 只允许本机。公网反向代理需要 `APK_MCP_HOSTS` 配置允许的域名，逗号分隔。带 Origin 的请求默认拒绝；浏览器 MCP 客户端需要部署者通过 `APK_MCP_ORIGINS` 设置带协议及明确端口的来源白名单。没有 Origin 的本机客户端可以调用。

请求体上限 256 KiB。MCP 请求在 SDK 前经过全局资源门禁；配置令牌后增加鉴权。退出时取消 MCP 服务再停止应用任务。当前不提供独立 stdio 服务，也不提供 MCP 原生长期任务协议；长期动作采用应用层任务 ID。

验证命令：`cargo test -p apk-server --test mcp --test mcp_notifications --test correlation`。覆盖无令牌、非法 Origin、工具发现、插件操作提交、共享任务读取、模式错误，以及现代目录订阅、普通/会话贡献、过滤、32订阅容量、断开回收和日志关联。

新增产物工具 artifact.inspect 与 artifact.archive.entries，均通过任务层执行；二进制传输保留在 HTTP，详见产物接口.md。
