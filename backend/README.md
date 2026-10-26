# DeviceForge Rust 后端

## 作用与适用场景
将设备调试、应用分析和插件扩展作为浏览器与 MCP 客户端可调用的服务器能力。设备和工具位于服务器主机，浏览器不直接操作本机文件或进程。

## 快速开始
在本目录执行 `cargo run -p apk-server`，默认监听 `127.0.0.1:7031`，未配置令牌时免鉴权。如需鉴权，设置 `APK_API_TOKEN`，HTTP/MCP 调用相应提供 Bearer 请求头。

统一分发使用根目录 CLI：本地 npx 包默认监听 `0.0.0.0`，提供前端/API 7030 和独立 MCP 7032，并支持 `--ip`、`--port`、`--mcp-port`。Rust 内部监听回环，由 CLI 固定代理；部署与插件便携包格式见 [命令行部署与插件安装](docs/命令行部署与插件安装.md)。

部署者可配置 `APK_ADB`、`APK_HDC`、`APK_DATA_DIR`、`APK_PLUGIN_DIR`、`APK_BIND`、`APK_MCP_HOSTS` 和 `APK_MCP_ORIGINS`。安装包分析另支持 APK_APKANALYZER、APK_APKSIGNER、APK_APKSIGNER_JAR、APK_JAVA 和 APK_BUNDLETOOL_JAR；当前不使用 APK_AAPT。

可选 `APK_OPERATION_BINDINGS` 指向静态旧操作绑定 JSON，详见 [操作绑定部署](docs/操作绑定部署.md)。目标未加载时入口不发布，同名内置入口不回退；配置变更需重启，插件运行装卸仍动态生效。

示例插件：执行 `cargo build -p deviceforge-echo-plugin`，按 plugins/echo/README.md 部署并填写绝对入口路径。服务启动时加载贡献，运行中可通过 HTTP/MCP 按插件 ID 加载、卸载和重载；配置令牌时携带鉴权。无需修改通用路由，契约及边界见 [运行中插件生命周期](docs/运行中插件生命周期.md)。

## 编译与磁盘占用
开发和测试构建默认关闭调试信息与增量编译，使用 16 个代码生成单元；保留开发断言、溢出检查及原有发布配置。这样减少后续构建占用，但修改后的重编译可能变慢，源码级调试需临时开启调试信息。

配置不会自动删除已有缓存或历史验收资料；适用范围、调试命令与旧产物处理边界见 [Rust 编译与磁盘占用](docs/guides/Rust编译与磁盘占用.md)。

## API 与验证
HTTP 推荐 `/api/v2`，业务 JSON 返回日志 ID；v1 保持兼容，MCP 在 `/mcp`。以 openapi.json 的运行时模式和 operations 列表为准。后端类型生成模式，不复制 DTO；导出命令：`cargo run -p apk-server --bin export-openapi`。

服务器采用 Tokio + Axum 异步运行时，线上任务与性能数据库分别使用 4 槽阻塞工作池。日志使用有界非阻塞 JSONL 写入、按日轮转、保留和退出刷新，HTTP/MCP/任务/插件调用关联方式见 [日志与关联契约](docs/日志与关联契约.md)。默认日志目录为数据目录的 logs；支持 `DEVICEFORGE_LOG_DIR/LEVEL/QUEUE/FILES`，其中等级、队列和保留数分别使用完整变量名 `DEVICEFORGE_LOG_LEVEL`、`DEVICEFORGE_LOG_QUEUE`、`DEVICEFORGE_LOG_FILES`。

门禁：`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`。测试覆盖任务状态、输入模式、并发、取消、重启恢复、设备解析、插件进程、HTTP 鉴权与 MCP 工具调用。无设备测试不代表真机通过。

## 独立后端文档
- docs/重写决策与文件骨架.md：命名、分层、性能和阶段计划。
- docs/架构与开发约束.md：开发边界与验收规则。
- docs/迁移清单.md：旧业务模块、迁移目标和完成证据。
- docs/接口设计.md：HTTP、任务与错误契约。
- docs/插件开发.md：跨语言协议与部署。
- docs/设备适配器插件架构.md：基础宿主、平台提供者、能力与会话边界，以及当前耦合和迁移验收。
- docs/设备提供者第一阶段实施.md：离散设备声明、目录、共享锁、任务生命周期和本阶段验收。
- docs/平台适配器迁出实施.md：公共工具库、独立平台插件、旧操作绑定、长安装与性能会话的迁出边界；工具库说明见 crates/tool-process/README.md。
- docs/MCP服务.md：MCP 工具及客户端接入。
- docs/命令行部署与插件安装.md：npx 本地分发、网络参数、部署路径及安装门禁。
- docs/原生插件分发.md：从 Cargo/公开清单派生平台包，release tgz 构建与实际安装验收。
- docs/合作取消插件协议.md：协议 3 控制帧、公开异步运行库与清理未确认状态。
- docs/在线插件安装架构.md：在线包、开放部署、安装/运行分离和当前实施边界。
- docs/在线插件接口.md：包上传/目录/删除、原生浏览器模块资源与调用方收敛规则。

前端实现通信、基础用例与可热装卸插件框架，具体界面待设计稿；其文档独立放置在 frontend/docs。当前尚未完成全业务重写，详细缺口见迁移清单。

真实运行验证：构建后执行 node scripts/runtime-smoke.mjs，验证实际 HTTP 监听、管理员插件目录、进程插件和持久化事件。

产物服务已接入：文档见 docs/产物接口.md；包括流式上传下载、元数据、ZIP 条目预览及同名 MCP 任务贡献。

设备安装与截图已接入：docs/设备产物操作.md；Android 单 APK 安装 / 卸载 / 截图、Harmony 单 HAP 安装 / 卸载共用任务层。runtime-smoke.mjs 会使用 rustc 编译模拟工具，验证真实 HTTP 与 MCP 的设备任务链路；没有真机验收。

安装包分析接口见 docs/安装包分析接口.md：APK / AAB 清单、APK 签名和 APKS 内 APK 提取已接入；反编译和 SDK 路径检测见 docs/反编译与SDK检测接口.md；AAB 转 APKS 见 docs/AAB构建接口.md；APKS 规格匹配提取与整包安装见 docs/APKS设备匹配接口.md；DEX 直接分析及高级匹配维度仍待实现。

APK_APKTOOL_JAR 配置反编译工具；反编译与 SDK 检测使用独立临时目录及产物 ID，真实包验收待完成。

进程插件产物协议版本 2 已接入，详见 docs/插件产物协议.md；公开示例 plugins/artifact-copy 演示输入副本与输出发布，协议版本 1 回显示例保持兼容。

Android 点击 / 滑动 / 按键 / ASCII 文本输入已接入共享任务操作 android.input，使用可替换领域端口、同设备串行与取消 / 总超时，详见 docs/设备输入接口.md。Unicode 输入法与 Harmony 输入仍待迁移，真机验收未完成。

Android 主进程 CPU / PSS / RSS 性能会话已接入，支持暂停 / 继续 / 结束、持久化样本和重启收敛；接口见 docs/性能会话接口.md。真实设备 FPS 采样与真机验收仍待迁移。

公开性能采样插件协议已接入，使用 APK_PERFORMANCE_PLUGIN 选择声明性能能力的插件；CPU / 内存与可选 FPS 窗口共用会话层。合成示例在 plugins/performance-demo，详情见 docs/性能采样插件协议.md；真实 FPS 工具与真机验收仍待迁移。

AAB 构建已接入 android.package.build_apks，支持 default / universal 模式；部署者通过 APK_BUNDLE_KEYSTORE、APK_BUNDLE_KEY_ALIAS、APK_BUNDLE_STORE_PASSWORD_FILE、APK_BUNDLE_KEY_PASSWORD_FILE 显式配置签名。请求仅选择产物和模式，详见 docs/AAB构建接口.md；真实包与真机仍待验收。

APKS 分包操作已接入：android.package.extract_splits 接收四个常见设备规格维度，发布带 APK 条目列表的 ZIP；android.app.install_apks 向指定设备安装 APKS，由 bundletool 匹配分包。两者共用任务与 MCP，详见 docs/APKS设备匹配接口.md，真实包与真机仍待验收。

本端独立开发要求见 AGENTS.md；新增自动依赖门禁 `node scripts/check-architecture.mjs`，不以文档约定代替实际检查。

标准 MessagePack 进程插件已接入 encode/decode/query，JSON/MessagePack 产物共同遵守受限编解码门禁，见 docs/MessagePack插件接口.md。旧 DLL 私有格式尚未证明兼容；通用 npx 安装入口和五个内置插件（含 cooperative_demo）的 Windows x64 release tgz 已交付，registry 发布及其他平台仍待完成。

在线 ZIP/npm TGZ 上传、部署目录/删除与浏览器模块资源已接入，包须自包含依赖，安装后由调用方显式启用。默认免鉴权，按可信插件运行；非空 APK_API_TOKEN 可选。上一阶段后端六门禁与 168 项 Rust 测试通过，debug/release 在线、日志、生命周期和合作取消真实服务通过；生产前端宿主与真实 npx 完成了该阶段集成验证。具体接口和重启/跨浏览器边界见在线插件文档，这些历史结果不代表新增设备范围的 release/npx 验收。

## 离散设备第一阶段当前交付（2026-10-09）

公开设备声明、当前代目录、精确版本能力调用、共享设备锁和热装卸已接入 HTTP/MCP，复用原插件贡献与任务生命周期。当前后端六门禁通过：13 模块架构、2 项架构规则测试、fmt、Clippy（-D warnings）、188 项 Rust 测试和工作区构建。

已核对当前 debug 报告：[设备集成](../artifacts/device-provider-smoke-debug.json) 的 25 项检查全部通过，35 次真实 Node 夹具调用均确认清理和进程退出；[浏览器集成](../artifacts/browser-plugin-smoke-debug.json) 整体与浏览器结果通过，覆盖公开设备上下文、提供者重载和旧引用拒绝；[日志集成](../artifacts/logging-smoke-debug.json) 的 4000 请求检查通过，零日志丢弃/写入错误并正常退出。上述设备为第三方模拟设备；首轮设备请求超时根因仍未确证，复跑通过不表示间歇问题已根治。

主代理已重建当前 release runtime 和五个原生插件包，release 设备 25 项、生产浏览器、日志 4000 请求、插件生命周期、合作取消和在线安装均通过。真实 npx 在同一包上验证显式令牌与默认免令牌两阶段，并实际安装公开设备示例、经 HTTP/MCP 发现/调用/拒绝旧引用，完整任务及事件历史保持一致。嵌套输入产物随后已通过独立 debug/release/npx 验收。Android/Harmony 平台迁出、常驻会话、iOS 和真机仍未完成，详见 [实施与验收边界](docs/设备提供者第一阶段实施.md)。设备 smoke 在项目根执行 `node scripts/device-provider-smoke.mjs`，发布重建后加 `--release`；最终状态以根 todo.md 为准。

公共工具库首步已完成：deviceforge-tool-process 与宿主回接、非合作清理守卫、14 模块/4 规则架构门禁及后端 248 项测试通过。当前 debug/release 与真实 npx 重新验收通过，详见 [平台迁出实施](docs/平台适配器迁出实施.md)。具体 Android/Harmony 与包工具插件仍待实施。
