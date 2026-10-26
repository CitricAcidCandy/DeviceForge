# MCP 插件开发指南

## 契约与职责

AI 开发 DeviceForge 插件前，调用只读工具 `deviceforge.get_plugin_development_guide`。工具无需加载任何业务插件，不提交任务，也不读取运行机器上的源码目录。初始化说明提供发现提示；客户端是否调用仍由其自身决定。

请求参数：

```json
{"target":"fullstack","topic":"overview"}
```

`target` 必填，为 `frontend`、`backend` 或 `fullstack`。`topic` 可省略，默认 `overview`；支持 `overview`、`manifest`、`sdk`、`lifecycle`、`examples`、`packaging`、`dependencies`、`validation`。未知字段、未知枚举、空值和类型错误均拒绝。

响应包含指南版本、当前宿主版本、前端 SDK 版本、后端任务与交互协议版本、完整发布格式及宿主 API 版本、请求主题和 `documents`。每份文档包含 `target/topic/source/content`；`source` 是源码归属说明，实际知识在 `content` 中，远端 AI 不需要访问该路径。`fullstack` 返回同一主题的两端文档。当前 `guide_version=3`，保留原七主题并新增共享依赖主题，声明 `release_format_versions:[1,2]` 与 `release_host_api_versions:[2]`。

## 编译与维护

前端知识源为 `frontend/docs/guides/plugin-development/`，后端知识源为 `backend/docs/guides/plugin-development/`，分别维护八个主题，共十六篇文档。server 的 `plugin_guide` 模块用 `include_str!` 将内容嵌入可执行文件；复制单个宿主程序或通过现有 CLI 运行包分发时，指南随二进制交付，不需要增加运行时文件路径配置。

`mcp.rs` 只路由调用和提供初始化引导，`mcp_tools.rs` 负责目录组合，独立指南模块负责参数、文档选择与响应。响应沿既有 MCP 日志元数据关联，不将指南当作异步任务。

修改公开 SDK、协议或示例后应同步对应主题，并重新编译宿主。文档修改不会热更新已运行的旧二进制；`host_version` 是软件版本，不能独立证明两个开发构建的内容相同。指南中的 `guide_version` 表示知识接口版本。

每次插件公开能力变更必须一并检查：

- 两端知识正文，尤其是声明、打包、共享依赖和验证主题；不能只更新普通实现文档或市场卡片。
- `plugin_guide/schema.rs`、`catalog.rs` 和 `query.rs` 的主题、固定来源、指南版本与支持格式；本维护说明随之更新。
- Node 固定来源及维护说明一致性测试、Rust MCP 路由测试；执行结果与尚未执行的门禁分别记录。
- 发布宿主重新编译后的真实 MCP 返回内容；不擅自重启用户服务，不把源码更新写成运行中旧 MCP 已更新。

## 第三版知识覆盖

十六篇覆盖完整发布及共享依赖：overview 说明完整功能与用户根；manifest 说明外层 release.json、两类独立组件、绑定与 requirements/any_of；sdk 说明 DEVICEFORGE_PLUGIN_RESOURCES、managed_resources、有效快照和原值优先；lifecycle 区分持久启用意图、当前实例、expected_revision、待配置或待依赖与旧管理入口；examples 保留原可运行组件示例和成套结构模板；packaging 区分 v1 全量工具闭包与 v2 统一依赖发布；dependencies 说明共享发现、安装、配置与脚本解释器；validation 列出失败和实际交付证据边界。

配套功能先定义通信，再以 `format_version:2,host_api_version:2` 组合服务器包、SDK v2 浏览器包与统一依赖声明，交由统一安装用例。独立组件包根携带 `dependencies.json`，完整发布在 `dependencies` 中使用同一公开描述；官方、第三方、原生、脚本与浏览器插件共用宿主能力，不按插件名单分支。v1 历史包保持可读，旧格式示例不是新版发布的唯一入口。

正常一次插件安装先发现后端环境变量、PATH、声明位置和整个 `.deviceforge` 共享仓库，已有兼容依赖直接复用，只自动下载缺失的必需项及配套依赖；启动和重新检测不下载。手动路径只是高级覆盖，不是自动发现的前置步骤。工具与配置持久化于 `DEVICEFORGE_USER_DIR`，不进入 npx 缓存，主 npm 包不附带工具归档。自动绑定和用户显式配置分离；卸载只释放自身引用，不删除其他插件仍使用的工具。

统一 HTTP 入口为 `/api/v2/plugin-dependencies/{target_kind}/{id}` 及其 `/scan`、`/install` 子路径；`target_kind` 为 `release/server/browser`，所属组件归并完整发布。MCP 查询使用 `deviceforge.get_plugin_dependencies`，写操作为 `dependency.scan` 与 `dependency.install`，携带 `expected_revision` 并查询任务终态。浏览器使用 `host.plugin-dependencies@1` 关联能力，不扫描访问者电脑或直接执行本机程序。

来源优先市场，仅市场资源缺失或连接失败时才使用声明的官方 HTTPS 来源；每个来源独立固定大小和摘要，完整性失败不能通过换源掩盖。无可信来源的依赖只提供发现与缺项信息，不能宣称全部官方工具均可下载。

资源服务器发布能力固定由 `GET /api/v1/capabilities` 声明版本、2 GiB 单资源上限、catalog 最后提交与不可覆盖版本。网页上传前探测，缺能力时提示升级且不写资源。沿既有资源与 catalog 协议完成发布，不新增服务器 ZIP 解包 API。知识更新、路由测试与构建不能证明网页发布、真实设备、正式分发或市场远端已验收。

## 验证入口

- `cargo test -p apk-server --test plugin_guide`（backend 目录）：工具发现与四项只读标注、三目标缺省主题、24 种组合的精确文档数量与固定来源、参数拒绝、日志和无任务副作用。
- `node --test scripts/tests/plugin-guide.test.mjs`（工程根目录）：核对十六篇固定嵌入来源、UTF-8、读取预算、第三版知识及本维护说明与响应元数据的一致性；执行两个完整组件示例，并用真实 TGZ/ZIP 校验成套模板身份、摘要、大小及离线闭包，确认在线路径转换后重算修订。此检查不发布资源、不安装宿主插件。
- `node scripts/plugin-guide-smoke.mjs`（backend 目录）：将当前 debug 宿主复制到临时空目录，显式隔离 `DEVICEFORGE_USER_DIR`、业务数据及两类插件部署目录，验证真实 MCP 返回嵌入指南，不读写真实用户根；报告保留在根 artifacts。可用 `--release` 验证已构建的 release 宿主。

历史记录：2026-10-23 第二版有限收口时，Node 定点测试 4/4 通过，宿主 smoke 仅语法检查通过，当时生产代码与十四篇嵌入文档未修改。该记录不代表第三版或当前构建通过；统一依赖管理的实际证据与未通过项见 `backend/docs/verification/市场插件依赖验收-20261026.md`，不能将 Node 归档验证计为真实 MCP、网页、设备或正式分发通过。

具体通过结果记录于根 `todo.md`；命令存在不表示已经执行。该功能不扩展 MCP Resources、Prompts、在线安装或设备调用权限。
