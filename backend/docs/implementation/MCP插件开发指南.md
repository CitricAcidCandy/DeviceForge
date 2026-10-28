# MCP 插件开发指南

## 契约与职责

AI 开发 DeviceForge 插件前，调用只读工具 `deviceforge.get_plugin_development_guide`。工具无需加载任何业务插件，不提交任务，也不读取运行机器上的源码目录。初始化说明提供发现提示；客户端是否调用仍由其自身决定。

对外知识面向拿不到宿主源码的插件开发者，必须可在独立工程消费。内容覆盖开发流程、公开能力与接口、约束、生命周期、调试和发布要求；不得返回源码位置或文档物理地址，不得要求克隆或阅读宿主源码、进入宿主目录、使用宿主仓库路径依赖、执行宿主生成器及构建或维护门禁。跨主题通过同一 MCP 工具继续查询，不能把必需信息留在仓库相对链接中。客户端直接使用 `documents.content` 正文，文档来源路径仅留在编译期维护。

公开 Rust SDK 是可选依赖；只有另行提供可独立消费的开发包后才使用，不假设 crate 已发布或编造下载地址。指南保留无 SDK 依赖的完整 Node.js 示例；Rust 处理器按 API 示意标明前置依赖，不能把示意声称为可直接构建的完整包。宿主内部维护流程留在工程文档，不进入对外指南。

请求参数：

```json
{"target":"fullstack","topic":"overview"}
```

`target` 必填，为 `frontend`、`backend` 或 `fullstack`。`topic` 可省略，默认 `overview`；支持 `overview`、`manifest`、`sdk`、`lifecycle`、`examples`、`packaging`、`dependencies`、`validation`。未知字段、未知枚举、空值和类型错误均拒绝。

响应包含指南版本、当前宿主版本、前端 SDK 版本、后端任务与交互协议版本、完整发布格式及宿主 API 版本、请求主题和 `documents`。每份文档只包含 `target/topic/content`；第四版删除此前返回仓库文档路径的 `source` 字段，调用方按目标和主题识别文档并直接使用正文。`fullstack` 返回同一主题的两端文档。当前 `guide_version=4`，保留八主题和请求参数，声明 `release_format_versions:[1,2]` 与 `release_host_api_versions:[2]`。

## 本次基础设施知识覆盖

指南使用 `guide_version=4`，八主题和请求参数不变，文档项不再含来源字段；两端 `validation` 直接包含公开调试流程。知识接口版本不等于浏览器 SDK 或插件协议版本，前端 SDK 仍为 v2，普通任务支持协议 1–4 或显式选择 6，独立会话继续使用 5。

- 前端 `sdk` 正文直接包含 `ServiceRef`、`TypedService`、`ServiceFeatureDiagnostic`、`ServerServiceAccess` 以及 `call/callTyped/whenAvailable/diagnostics` 签名，不能只提供指向仓库实现文档的链接。
- 前端 `lifecycle` 正文包含加载激活 30 秒、挂载 10 秒、整次清理 5 秒、功能级等待/撤销/重建、旧代隔离和诊断边界；超时结束宿主等待，不表示能强制停止可信 JavaScript。
- 前端 `examples` 正文包含可执行 `service-consumer.mjs`：提供者缺失时保留独立命令，提供者就绪后类型化调用，撤销只影响相关功能，换代后重建。
- 后端 `manifest/sdk/lifecycle` 包含可选服务声明、协议 6 公开运行入口、精确版本与 Schema、父子期限和取消、深度 8/活动后代 4 的限制。旧 JSON 清单可省略服务，Rust 结构体字面量需补 `services: None`。
- 共享 React 导入、业务页面接管成功前的回落、路由命名空间与归一化碰撞说明保留在前端固定主题中；不把业务页面接管描述为完整替换产品外壳。
- 默认总览直接区分独立 `panels`、具名 `components`、自有页面 `modules` 与服务；列出 `devices.apps`、设置分组及路由保护边界。示例提供复用原面板 `mount` 的应用区域接入片段，明确整个区域接管与每行名称／图标扩展的差别。总览、清单、SDK 和示例必须一致，不能继续只介绍旧工坊插槽或声称插件模块不生成产品导航。

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

- 无源码开发边界：在工程根执行 `node --test --test-name-pattern='MCP 插件开发知识允许无宿主源码独立开发|MCP 维护说明与实际指南版本|八主题十六篇嵌入文档|MCP 正文自包含服务 API' scripts/tests/plugin-guide.test.mjs`。检查十六篇正文及入口提示，不要求插件开发者运行此宿主维护测试；本命令只供本仓库维护者使用。
- `cargo test -p apk-server --lib plugin_guide::query::tests -j 1`（backend 目录）：参数校验、三目标八主题、公开文档字段和自包含知识的直接单元检查。
- `cargo test -p apk-server --test plugin_guide`（backend 目录）：工具发现与四项只读标注、三目标缺省主题、24 种组合的精确文档数量及无来源字段、参数拒绝、日志和无任务副作用。属于路由集成检查，按任务范围选择，不与直接单元检查自动整套执行。
- `node --test scripts/tests/plugin-guide.test.mjs`（工程根目录）：核对十六篇固定嵌入来源、UTF-8、读取预算、第三版知识及本维护说明与响应元数据的一致性；执行两个完整组件示例及公开服务组合消费方，验证等待、调用、输入拒绝、局部撤销和换代恢复。再用真实 TGZ/ZIP 校验成套模板身份、摘要、大小及离线闭包，确认在线路径转换后重算修订。此检查不发布资源、不安装宿主插件。
- `node scripts/plugin-guide-smoke.mjs`（backend 目录）：将当前 debug 宿主复制到临时空目录，显式隔离 `DEVICEFORGE_USER_DIR`、业务数据及两类插件部署目录，验证三目标八主题共 24 种真实 MCP 查询。逐篇核对返回正文与当前十六篇固定来源的 SHA-256，检查服务 API、生命周期和协议 6 知识自包含，确认查询不创建任务、宿主正常退出、端口释放及临时目录删除；不读写真实用户根。报告保留在根 artifacts，可用 `--release` 验证已构建的 release 宿主。

历史记录：2026-10-23 第二版有限收口时，Node 定点测试 4/4 通过，宿主 smoke 仅语法检查通过，当时生产代码与十四篇嵌入文档未修改。该记录不代表第三版或当前构建通过；统一依赖管理的实际证据与未通过项见 `backend/docs/verification/市场插件依赖验收-20261026.md`，不能将 Node 归档验证计为真实 MCP、网页、设备或正式分发通过。

具体通过结果记录于根 `todo.md`；命令存在不表示已经执行。该功能不扩展 MCP Resources、Prompts、在线安装或设备调用权限。

## 2026-10-27 无源码开发边界修订

- 用户进一步限定公开知识范围为流程、能力与接口、约束、生命周期、调试和发布要求；第四版删除响应文档项的 `source` 字段，源码和文档物理路径不再返回。两端总览给出八主题用途，`validation` 增加通过公开目录、Job、事件、日志及取消状态排错的流程。
- 最新限定 Node 指南单元 4/4、Rust 指南直接单元 3/3 通过；Rust 单元检查三目标八主题的文档字段恰为 `target/topic/content`。路由测试与宿主验收脚本已同步第四版，但本轮未运行这些集成检查或完整构建，未部署或重启服务。
- 初始化提示、工具说明与两端指南均改为公开接口和独立工程流程；去除宿主目录、源码路径依赖、内部文档跳转与宿主生成器/构建/维护要求，跨主题通过 MCP 查询。
- 新增回归检查先因总览缺少明确开发边界失败，修订后最终四项相关指南单元检查通过。没有执行全量、构建、浏览器或设备验收，没有部署或重启用户服务。
- 本轮现场 7031 查询返回 `guide_version=2`，其中存在旧源码要求。这里的修改随后续宿主编译发布；尚未证明当前运行服务已更新。以下历史构建和验收记录属于此前版本，不能转计本次修订。

## 2026-10-27 此前维护结果（历史记录）

- 先建立两条失败回归，再补正文与完整服务消费方；根指南测试 7/7、指南 Rust 单元 3/3、HTTP/MCP 集成 4/4 通过，架构、8 项架构测试、格式和工作区严格 Clippy 通过。
- `cargo build --workspace -j 1` 与 `cargo build -p apk-server --release -j 1` 均通过。生成程序位于 `backend/target/debug/apk-server.exe` 与 `backend/target/release/apk-server.exe`，未覆盖既有预览部署或根 runtime。
- 新 debug/release 程序各自从无源码的临时目录运行，真实 MCP 各 31 项检查通过；24 种查询涉及的十六篇正文均与当前来源 SHA-256 一致，宿主零退出、端口释放、临时目录删除。原件分别为根 `artifacts/plugin-guide-debug-1cc391ff-e69b-4dec-aafb-c6d8e97ad86d.json`、`artifacts/plugin-guide-release-e1c1d5cc-0519-4126-8094-60db0ccad867.json`。
- 本轮 `cargo test --workspace -j 1` 未全绿：鸿蒙设备 `protocol` 目标有原期限和子进程退出两项断言失败，未排查或改写该插件；失败日志保留，不用指南专项通过覆盖整轮失败。完整汇总见[本轮维护记录](../../../artifacts/plugin-guide-maintenance-20261027/summary.json)。
- 用户自行重启服务。现有 `启动后端.bat` 固定指向 `artifacts/device-workspace-preview-20261014/server-mirroring-release-20261023.exe`，不会自动采用本次 target 中的新宿主；本轮未切换入口、替换该程序或迁移数据。旧程序重启后仍可能返回旧知识，须核对实际二进制及 `frontend/sdk` 正文是否包含 `whenAvailable`。

本轮没有修改前端业务源码，也不重新宣称浏览器、真机、投屏、性能或正式分发已验收。

## 2026-10-28 Debugger 独立示例与验证知识交接

- 独占新增 `examples/debugger-demo/`：原生 ESM SDK v2 浏览器组件、无 SDK Node 协议 1 服务器纯回显、中文 README、四个直接测试文件与自有 ZIP 打包器。目录可单独复制使用，没有宿主类型路径、仓库导入、npm 外部依赖或未发行包假设；宿主由部署者提供 localhost 发行版，不访问设备。
- 两端 `validation` 仅更新 Debugger 章节，按当前真实代码同步公共 `host.debugger@1` 八个动作、重新连接确认、服务器 operation/service 原 Job、浏览器可选结果、日志双来源和持久分页、报告 `export=none/json/markdown` 与 `{report,artifact}`、冻结快照经 `ui_tree` 续页，以及换代后显式重新选择。实现核对结束时并行后端已向 HTTP/MCP 注入真实日志适配器；运行中发行版和真实联调证据仍未由本轮验证，不再沿用“只有元数据事件／不支持报告产物”的旧说明。
- 2026-10-28 Node v24.14.0，仅执行示例内四个明确文件：`node --test --test-isolation=none --test-concurrency=1 tests/browser.test.mjs tests/server.test.mjs tests/package.test.mjs tests/debugger-client.test.mjs`，21/21 通过。覆盖可选 debug、独立挂载清理、失败回滚、取消晚到、原 Job 与日志、调试服务／快照续页、真实协议 stdin/stdout、标准 CRC、ZIP 闭包及复制后独立打包。五个自有协议子进程均已确认退出，临时目录已回收。
- 归档在单元测试临时目录内实际生成并核对；固定交付包可在该独立目录执行 `npm run pack` 生成 `dist/browser.zip`、`dist/server.zip`、`dist/debugger-demo.zip`、`dist/checksums.json`。本轮未执行此固定目录打包命令，不把测试临时归档写成现存发布文件。
- 保留 `production_acceptance_complete=false`。未追加 Cargo、全仓、浏览器、设备、完整构建或用户服务操作；未改官方面板及 Debugger 宿主实现，未执行指南宿主嵌入／路由验证或真实安装。根 todo 与总体发布记录由主代理集成，本角色遵守独占写集不重复接手。此前维护记录及其他并行更新保留。
