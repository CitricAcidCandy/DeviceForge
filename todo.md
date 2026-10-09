# DeviceForge 开发与验收记录

## 当前目标
在 G:\Rust\DeviceForge 独立重写旧 ApkTool，以 Rust 端口与适配器架构优先交付后端，前端仅提供 Svelte 5 / TypeScript 骨架和扩展契约。HTTP 与 MCP 共用任务层；最终提供 npx 启动前后端和插件安装。整体目标继续进行。

## 2026-10-09 工程位置与独立约束
- 已将源目录中的新工程复制到当前工作区的 DeviceForge/backend、frontend，不复制 target、node_modules、dist 和运行数据，未删除或恢复旧工程修改。
- 根 AGENTS.md 仅保留共同规则；backend/AGENTS.md、frontend/AGENTS.md 独立明确职责、依赖、性能/资源、测试及交付要求，均已验证可按 UTF-8 读取。
- 后端新增 Cargo 元数据架构门禁，检查生产/构建依赖、公开 SDK、领域外部依赖与工程外路径；2 项拒绝规则测试通过。
- 前端新增 TypeScript/Svelte 语法架构门禁，检查反向依赖、跨功能耦合、循环、路径别名、类型引用、动态导入与直接网络调用；接入 npm run check。静态门禁不能证明运行时信任、视觉或副作用正确。
- 新目录完整门禁通过：后端架构检查及 2 项规则测试、fmt 检查、Clippy（-D warnings）、workspace 108 项测试与构建；前端 generate:api、架构/Svelte/TypeScript（0 错误、0 警告）、7 项测试及构建。内置 ADB / 公开性能插件两种 runtime-smoke 均通过。

## 2026-10-09 标准 MessagePack 插件
- data-codec 公共库：JSON/MessagePack 16 MiB、64 层、100000 节点；先预扫描二进制结构再分配；保留 i64/u64，拒绝重复 JSON 键与越界整数。
- plugins/msgpack：协议 2 独立进程，encode/decode/query；查询先筛选后分页，支持 equals/contains/greater/less 和 ID equals + limit=1；结果最多 128 KiB。
- 宿主产物扩展 JSON/MessagePack，上传与插件输出共用内容校验，流式上传提前执行 16 MiB 类型限额；JSON/MessagePack 拒绝 ZIP 预览，OpenAPI 添加下载媒体类型。
- 新增中文库/插件 README、MessagePack 接口文档与部署清单，更新产物/插件/迁移说明；运行脚本增加 HTTP 编码、MCP 解码/筛选、下载摘要和非法数据/体积拒绝。
- 标准 binary/ext、无效 UTF-8、非字符串或重复键、非有限浮点可存储但不能保真转换为普通 JSON，转换明确拒绝。JavaScript 大整数解析风险单独说明。
- 本轮新增 16 项 Rust 测试：编解码 6 项、查询 4 项、授权/副本/不覆盖 2 项、真实插件进程 2 项、宿主数据产物 2 项；新目录全量 108 项通过。HTTP 编码、MCP 解码/筛选、下载摘要、非法类型/数据/体积拒绝在两种部署模式均通过。旧 libmsgpcak_dll.dll 私有容器无有效格式证据或样本，不能宣称完整兼容。

## 已有实现，仍需按迁移清单逐项验收
- 任务注册/SQLite/事件/取消恢复、HTTP/OpenAPI/MCP、插件协议 1/2、受控产物。
- 设备枚举/连接/启停/包列表，Android 单 APK 安装/卸载/截图/基础输入，Harmony HAP 安装/卸载。
- APK/AAB 清单、APK 签名、APKS 提取、Apktool 反编译、SDK 路径检测、AAB 双模式构建、常见设备规格分包提取/安装。
- CPU/PSS/RSS 性能会话和公开性能采样插件/可选 FPS 窗口；真实 FPS 工具及真机未验收。

## 后续必需工作
- [x] npx 本地 tgz 统一启动前后端，失败/信号退出后清理进程；Windows x64 release 安装包验收。
- [x] npx 从目录/tgz/npm 包安装插件，清单和平台入口验证、失败清理与原子部署；真实本地 tgz 与依赖分发验收。
- [ ] npm registry 公开发布、其他平台构建矩阵、另一台局域网客户端与防火墙验收；npm 远端插件获取单独验收。
- [x] 四个内置 Rust 插件的 Windows x64 便携 tgz；真实 npx 安装及 HTTP/独立 MCP 行为验收。
- [ ] 公开设备提供者 SDK、统一设备目录与能力路由；Android/Harmony 平台实现迁出宿主，iOS 通过独立适配器扩展。
- [x] 完整宿主日志框架：v2 响应体日志 ID、HTTP/MCP/任务/插件关联、有界非阻塞落盘、轮转/保留/丢弃观测及本机性能测量；持续生产负载另行验收。
- [ ] Frida、自动化录制/回放、投屏/浏览器流媒体、配置与工具供应，按后端迁移清单推进。
- [ ] 旧 MessagePack 私有容器样本与 DLL 对照，高级分包匹配与全局设备互斥。
- [x] 通用进程插件运行中加载/卸载/重载、代际与任务取消清理；设备提供者与常驻会话另行验收。
- [ ] 常驻插件、设备层热拔插、派生进程树、磁盘硬配额与历史保留/删除。
- [ ] 真实 APK/AAB/APKS/证书、Android/Harmony 真机、真实 FPS 与生产负载验收。

前端本阶段完整业务页面不在范围，动态加载器与实际宿主上下文未实现。未提交 Git，不修改旧工程技术索引。

## 2026-10-09 npx release 分发与局域网入口

- 根 npm 包 `@deviceforge/cli` 提供 start、plugin install/list，无生产 npm 依赖；携带后端、Rust 离线插件门禁和前端静态资源。CLI 文件按参数、网络、生命周期、代理、进程、运行包和安装职责拆分，另有独立 cli/AGENTS.md。
- 默认 `0.0.0.0`、前端/API 7030、MCP 7032，支持 `--ip`、`--port`、`--mcp-port`；局域网要求部署令牌。内部 Rust 仅回环监听，MCP Host/Origin 校验保留，令牌不进入静态资源、输出和插件。
- 插件便携包支持 Node/native 平台入口。安装禁用 npm 生命周期脚本，保留依赖布局，同卷独立暂存、同 ID 锁、Rust 共用注册校验、原子发布且拒绝覆盖。相对 APK_PLUGIN_DIR 在安装/列举/启动统一解析为绝对路径。
- Rust 新增独立 validate-plugin 程序，共用 application/registration 规则；本轮此前后端 fmt、Clippy、109 项 Rust 测试、构建和两种 runtime-smoke 通过，前端 generate:api/check（0 错误/警告）、7 项测试与构建通过。
- 正式 `cargo build --locked --release -p apk-server --bins` 与 prepare-runtime 完成；以 release 运行包重新执行 CLI 7 项测试全部通过。真实 npm pack/npx 验证 tgz 插件依赖、安装脚本禁用、相对独立插件目录、HTTP 任务、独立 MCP、默认局域网以及退出清理，覆盖回环和本机局域网两个地址。
- 持久交付 `artifacts/deviceforge-cli-0.1.0.tgz`，约 8.35 MB 压缩 / 21.27 MB 展开，当前仅 Windows x64。npm prepack 校验版本、平台入口、SHA-256 与首页；根 README、后端部署/插件/迁移文档、前端静态分发文档分别更新。
- 未公开发布 registry；npm 远端插件获取、另一台局域网客户端、防火墙、其他平台、真机和页面视觉尚未验收。内置 Rust 插件的便携包完成情况见后续记录；更新/卸载/热加载、来源签名、安装依赖硬配额与系统沙箱未实施。整体重写继续进行。

## 2026-10-09 四个原生插件分发

- 从 Cargo 元数据及示例清单派生 npm 包计划，校验版本、唯一 binary、插件 ID、平台和入口；release 构建显式使用本机 Rust target。插件包只保留便携清单，安装后由 CLI 映射入口，再使用 Rust 共用注册规则验证。
- 已生成 echo、artifact-copy、performance-demo、msgpack 四个 Windows x64 tgz，并重新生成正式 CLI tgz，均位于 artifacts。根 npm test 10 项、新脚本语法检查、架构门禁及 2 项规则测试通过。
- 真实 npx 验证 Node 依赖插件和四个 release 原生插件，覆盖 HTTP 回显、JSON 上传、产物字节/SHA-256、MessagePack 编码、独立 MCP 解码/筛选、合成性能采样、相对插件路径、安装脚本禁用、回环/本机局域网入口及退出清理。
- 两次全量检查发现 AAB 构建/分包提取模拟工具的标记文件发布竞态，夹具改为临时文件关闭后重命名发布，生产超时保持原值。最终 fmt、Clippy、109 项 Rust 测试、工作区构建及两种 runtime-smoke 通过。
- 原生插件分发文档与各插件部署 README 已独立更新。性能示例为合成数据，设备工具为模拟进程；registry、另一台主机、其他平台、真机和生产负载未验收。

## 2026-10-09 设备适配器与基础宿主决策

- 后端新增设备适配器插件架构文档：宿主负责注册/目录/能力路由/任务/互斥/产物/鉴权/日志，平台插件负责发现、连接、平台工具及特有业务。身份包含提供者归属，能力支持和实时可用状态分开，常驻传输与热装卸单独定义。
- 前端新增设备能力与插件面板文档：通用工作台按能力展示，平台特有流程由独立面板提供，日志 ID 由 API 适配器提取。两端 AGENTS.md 独立增强开发边界，并补文档导航。
- 已核对当前耦合：server/main.rs 直接装配 DeviceTools、设备产物、Android 输入/分包安装及默认性能探针；devices.rs 仍有平台分支。本次只完成架构决策和开发约束，未声称设备提供者、iOS 或热拔插已实现。
- 此边界评估阶段尚未实施完整日志；后续异步与日志阶段已完成基础实现和本机验证，证据见下节。任务事件仍不替代诊断日志。

## 异步运行、日志与关联验证（2026-10-09）

- Tokio + Axum 异步服务；任务与性能存储各 4 槽阻塞工作池，线上 HTTP/MCP 改用异步入口。取消等待者不能提前释放后台阻塞名额；请求最多 128 个在途响应，流结束、错误或断开释放。
- 公共 observability 模块提供可信日志上下文、有界非阻塞 JSONL、按日轮转、保留、记录大小限制、丢弃/写入错误统计和退出刷新；v2 成功/失败体、MCP 元数据、后台任务与插件请求关联，v1 兼容及产物原字节保留。
- 后端架构及 2 项规则测试、fmt、Clippy、123 项 Rust 测试和构建通过；慢存储与取消/流名额回归通过，两种 runtime-smoke 通过。前端 generate:api/check（0 错误/警告）、7 项测试与构建通过，只更新生成类型及独立文档。
- debug/release 真实日志 smoke 通过；release 本机 32 并发任务查询约 5896 请求/秒、p95 7.74 ms，该轮日志零丢弃。日志突发 30000 条提交另测，实际落盘 9476、队列丢弃 20524，提交速度不能视为落盘吞吐。
- 正式 Windows x64 release 运行包重建，根 Node 10 项测试、真实 npm pack/npx 四原生插件与 Node 依赖插件、回环/本机局域网地址、独立 MCP 及正常退出日志刷新通过。报告位于 artifacts；详细边界见 backend/docs/异步与日志性能验收.md。
- 设备文档重新明确为候选架构并补影响/收益/代价，未制定具体提供者 API；热拔插保持整体目标。公开设备 SDK、常驻传输、动态注册、iOS、完整业务和真机仍未完成，不宣称整体迁移完成。

## 通用进程插件生命周期（2026-10-09）

- domain 增加异步 PluginCatalog 与生成 PluginInfo；application 抽出动态注册、原子贡献发布、目录修订、独立代际与所有权跟踪。基础设施从固定部署根按 ID 受限读取清单；server 仅装配与协议转换。
- 鉴权 HTTP v2 与 MCP 共用 load/unload/list。卸载撤销新调用，取消并等待排队/运行任务；重载生成新代际，旧快照无法准入。管理工作最多 2 个、变更串行，客户端取消等待不取消收敛；长期性能探针依赖明确保护。
- 新增 9 项 Rust 行为回归，后端工作区共 132 项通过；架构及 2 项规则测试、fmt、Clippy、构建通过。两种 runtime-smoke 与 debug 日志 smoke 通过；前端生成/check（0 错误警告）、7 项测试和构建通过，仍只更新生成类型及独立文档。
- debug 真实 HTTP/MCP 验证空插件启动后部署、加载/卸载/重载、历史保留、4 个独立插件进程退出、1 个排队任务取消、MCP 游标失效与生命周期日志关联。报告位于 artifacts/plugin-lifecycle-smoke-debug.json。
- 正式 Windows x64 release 运行包已重建，根 Node 10 项测试与真实 npm pack/npx 验收通过，包括服务启动后安装 Node 依赖插件、HTTP 加载与独立 MCP 卸载/重载、四原生插件、两个本机地址及正常退出日志刷新。正式 artifacts/deviceforge-cli-0.1.0.tgz 为 8852301 字节。
- release 插件生命周期与日志 smoke 通过，报告在 artifacts；4 个独立插件进程已退出、1 个排队任务取消，历史任务保留。当前观测耗时不代表长期生产容量。
- 设备提供者 SDK、常驻会话、平台实现迁出宿主、iOS、部署文件更新/删除和真机未实施或未验收，整体目标继续进行。
