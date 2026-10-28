# 服务器插件开发概览

推荐流程：只维护一份 manifest.json 开发清单（manifest_version:1），在 components 中声明服务器/浏览器能力，在 market 中声明展示资料；两者完整结构、默认值和示例均由 manifest 主题直接提供。使用带 plugin pack 命令的 DeviceForge CLI 发行包自动生成运行、市场和发布清单，再 plan/publish 或离线安装；命令详见 packaging 主题。Cargo.toml/package.json 仅保留语言工具链职责，不重复维护 DeviceForge 元数据。

使用 MCP 工具 `deviceforge.get_plugin_development_guide`，指定 `target=backend` 与所需 `topic` 获取正文；配套开发使用 `target=fullstack`。响应给出宿主版本、指南版本和公开协议版本，知识随宿主版本交付。

插件在自己的独立工程开发，无需获取宿主源码。直接使用 MCP 返回的 `documents.content`、公开操作目录与 JSON Schema，按主题继续查询其他正文。公开 SDK 是可选开发依赖，取得可独立消费的 SDK 开发包后才使用；没有开发包时可按本指南 JSON 协议实现，`examples` 的 Node.js 完整包不依赖 SDK。

知识范围包括开发流程、公开能力与接口、约束、生命周期、调试和发布要求。`overview` 介绍能力与开发顺序，`manifest` 描述声明约束，`sdk` 提供公开接口，`lifecycle` 说明运行和清理，`examples` 提供示例，`dependencies` 描述共享依赖，`packaging` 说明发布要求，`validation` 提供调试流程与结果核对。正文直接交付，不包含宿主源码位置或文档物理地址。

## 能力与边界

服务器插件运行于独立进程，可使用 Rust、Node.js、Python、Go 等语言，通过公开 JSON 协议贡献任务操作；可声明产物、设备提供者、性能来源和独立交互会话。普通操作注册为 `plugin.<插件ID>.<操作名>`，HTTP 和 MCP 共用同一操作目录、输入校验与任务生命周期。插件不能直接引用宿主领域、应用、基础设施、数据库或私有路由。

本地与同事局域网部署默认免鉴权；部署者可配置 `APK_API_TOKEN`。插件按可信代码运行于服务账户权限，独立进程不是操作系统沙箱。工具位置、签名材料和设备连接等由部署者或公开执行上下文提供，浏览器业务输入只传业务参数与产物 ID。

## 选择协议

| 协议 | 用途 | 入口与结束方式 |
| --- | --- | --- |
| 1 | 无外部资源的短任务、纯计算或回显 | 一份请求，一份响应，标准输入随后关闭 |
| 2 | 需要输入副本或输出文件的短任务 | 任务请求附产物上下文，结果由宿主发布 |
| 3 | 需要合作取消和显式清理确认的任务 | 输入流保持开放，取消控制帧，响应声明清理结果 |
| 4 | 需要固定本地执行期限的任务 | 在协议 3 资源语义上使用 Ready/Start 与 `InvocationContext` |
| 5 | 持续输入、标准输出/错误双路输出的交互会话 | 单独的会话声明与运行库入口；不是普通任务版本 |
| 6 | 任务内反向调用公共服务 | 独立帧、Ready/Start、类型化句柄与合作清理，不经过 HTTP |

清单顶层 `protocol_version` 可选 1–4，或显式选择支持反向公共服务的 6；独立会话在 `sessions` 声明协议 5。每个任务或会话启动自己的插件进程；公共服务映射已有普通操作，不另建常驻 RPC 进程。协议 6 与服务契约版本字符串无关，声明、运行入口和生命周期分别查询本指南的 `manifest`、`sdk` 与 `lifecycle` 主题。

## 推荐开发顺序

先用 `manifest` 确定贡献、输入模式和预算，再用 `sdk` 选择协议和公共库，按 `lifecycle` 实现期限、取消和清理。`examples` 提供可直接运行的 Node 协议 1 包与 Rust 协议 4 入口；`packaging` 说明自包含包、部署和加载；`validation` 列出实际调用与失败检查。

配套浏览器插件通过公开 `HostContext.listOperations/submit/getJob` 调用服务器操作，查询终态后读取结果；文件先上传得到产物 ID，再由服务器声明选择输入，输出仍以产物 ID 下载。

当前推荐交付一个完整功能发布：`release.json` 使用 `format_version:2`、`host_api_version:2`，组合同一功能的服务器组件、浏览器组件和工具依赖，市场只展示一个功能条目。两类组件的底层包格式保持独立；统一安装器负责成套计划、安装、配置、启停与更新，缺必需输入时为 `configuration_required`。旧单组件安装/加载入口保留兼容，不能用它拆装已经归统一发布管理的组件。

配置、插件和工具归运行宿主的用户根，默认 `<home>/.deviceforge`，宿主可用 `DEVICEFORGE_USER_DIR` 指定。根 `config.json` 保存启动/市场配置，插件配置分别保存于 `plugin-configurations/server` 与 `browser`，工具位于 `tools`；npx 缓存只保存运行分发文件。托管资源用 SDK 与 `DEVICEFORGE_PLUGIN_RESOURCES` 读取，用户高级路径覆盖保留优先级；不把开发机绝对路径、令牌或示例项目写入发布默认值。在线来源和含完整闭包的离线 ZIP 走同一安装用例，具体字段见 `manifest`、`sdk` 和 `packaging`。


新版统一依赖使用 dependencies.json（独立组件）或 v2 清单的 dependencies，先自动发现本机与用户根共享工具，一次安装只下载缺失必需项；启动与重新检测不下载。v1 保留兼容。完整字段、来源约束与管理接口通过本指南工具查询 `dependencies` 主题。
