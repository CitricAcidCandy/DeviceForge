# DeviceForge · 设备工坊

浏览器 / 服务器架构重写工程。Rust 后端提供公开业务与插件契约；浏览器端已按用户选定的电子设备工坊背景实施 React 产品界面，接入14个业务路由和运行中插件扩展。工程和 SDK 身份为 DeviceForge，展示品牌为 FORGE。

资源中心位于根目录 `resource-server/`，由部署者独立运行 `npm run start:resource-server`，默认地址为 `http://127.0.0.1:7040`。npx 启动参数 `--marketplace-url` 仅指定市场地址，多来源可使用 `--marketplace-config`；资源服务不随 npx 打包或启动。

后端入口：backend/README.md。后端文件骨架、开发约束、接口设计、MCP 服务及核心迁移清单全部存放在 backend/docs。

前端入口：frontend/README.md。前端架构、开发约束和浏览器插件契约独立存放在 frontend/docs。

独立工程位于 `G:\Rust\DeviceForge`，旧 Electron 工程只作业务行为对照。新架构采用可替换端口和适配器，通过公开操作贡献接入设备工具及独立进程插件，HTTP 和 MCP 共用任务层。内部 apk-* crate 名称暂保留。

当前实现与证据以 [当前进度与新会话交接](docs/当前进度与新会话交接.md) 为准。统一功能插件的清单、共享工具、配置持久化、成套前后端安装与分发入口见 [统一安装契约](backend/docs/contracts/统一插件安装v1.md)、[开发者发布工具](scripts/plugin-releases/README.md) 和 [用户安装操作](frontend/docs/implementation/统一插件安装前端接线-20261022.md)。各业务的真机、性能与公开发布分别验收。

Rust 服务使用 Tokio + Axum 异步架构，线上任务与性能存储通过受限阻塞工作池执行。日志采用有界非阻塞 JSONL、轮转/保留和退出刷新；v2 HTTP、MCP、后台任务与插件调用携带关联日志 ID，v1 保留兼容。公开契约见 [日志与关联契约](backend/docs/contracts/日志与关联契约.md)，前端消费要求独立放在 [日志 ID 与接口消费](frontend/docs/contracts/日志ID与接口消费.md)。通用进程插件支持运行中加载/卸载/重载。公开离散设备提供者、能力路由与前端设备上下文已实现，当前 debug/release 设备、真实浏览器及 npx 分发集成通过；平台实现迁出宿主、常驻连接与真机尚未完成。

本地/同事局域网默认免鉴权，APK_API_TOKEN 可选，配置后执行令牌检查。在线插件按可信代码运行，不要求权限审批或强制隔离。浏览器可在线提交服务器包与浏览器包并热装卸；公开组件、模块、命令、服务、状态和任务提交钩子已接入运行平台。接口与生命周期见[后端在线安装架构](backend/docs/implementation/在线插件安装架构.md)、[前端在线插件与开放扩展](frontend/docs/implementation/在线插件与开放扩展.md)。本轮产品范围和实际证据见[产品实施方案](frontend/docs/implementation/产品界面实施方案.md)及[产品验收](frontend/docs/verification/产品界面验收.md)，真机与正式分发继续独立记录。

开发要求分别见 [backend/AGENTS.md](backend/AGENTS.md) 和 [frontend/AGENTS.md](frontend/AGENTS.md)，两份文件独立包含职责、依赖、资源与检查要求。启动器另遵守 [cli/AGENTS.md](cli/AGENTS.md)，根目录只保存共同规则和工程导航。

## Windows 预览后端控制台

双击根目录的 `启动后端.bat`，启动或连接本仓库编译的后端，并在同一窗口持续显示最近 20 条与后续新增的服务器日志。日志保留北京时间、级别、消息及日志 ID 等排查信息；完整 JSONL 仍保存在窗口显示的服务器日志目录。

- 输入 `stop` 后回车，或按 Ctrl+C：请求后端正常停止并等待退出。
- 输入 `quit` 后回车：仅退出日志查看，后端继续运行。
- 输入 `status` 后回车：查看进程与健康状态。
- 双击 `停止后端.bat`，可独立停止同一预览后端。

命令行还支持 `启动后端.bat --background` 只启动后台服务、`--status` 检查状态、`--stop` 停止、`--help` 查看帮助。PowerShell 兼容入口为 `scripts/start-backend.ps1`，对应 `-NoFollow`、`-Status`、`-Stop`、`-Help`。

此入口使用 `backend/target/debug/apk-server.exe`，后端先在 `backend` 目录执行 `cargo build --locked -p apk-server --bin apk-server`；前端正常执行 `npm run dev` 或 `npm run build`，会自动构建并带上官方调试器。调试器使用说明见[官方插件说明](examples/browser-debugger/README.md)。数据及插件目录沿用 `scripts/backend-console/deployment.mjs` 的原部署，监听 `0.0.0.0:7031`，不迁移到 npx 的用户数据目录。旧固定程序仍运行时先使用原停止入口正常退出，再重新启动。HTTP 与 MCP 在同一个后端进程中启动，MCP 地址为 `http://127.0.0.1:7031/mcp`；该入口不另起 MCP 进程或 7032 监听。普通业务继续支持可信局域网访问，调试功能仅在本机回环连接开放。

停止只接管身份一致的预览服务器，其他程序占用端口时明确拒绝；关闭服务优先通过公开接口完成。若日志确认宿主已成功结束、没有业务子进程或监听，但旧宿主进程仍挂起，才回收同一身份的单个残留进程并说明原因。直接点窗口关闭按钮不能保证正常停止，主动结束服务请用 `stop` 或独立停止入口。

## 本地 npx 启动

构建者执行 `npm run pack:cli` 生成当前平台运行包；使用者只需 Node.js 22.18 或更高版本及 npm。包携带预编译 Rust 后端、离线插件校验器和前端静态资源。在项目根目录执行；如需鉴权再配置 `APK_API_TOKEN`：

```powershell
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge start --ip 0.0.0.0 --port 7030 --mcp-port 7032
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge plugin install .\my-release.zip --api-url http://127.0.0.1:7030
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge plugin list
```

默认允许局域网访问，前端/API 使用 7030，独立 MCP 使用 7032；可分别指定 IP 和端口。完整发布安装调用已运行的服务，自动准备服务器组件、可选浏览器组件与必需工具；支持市场清单和完整离线 ZIP。账号、项目、签名等必要输入不足时显示“需要配置”。统一安装的组件、工具与插件配置固定归属 `DEVICEFORGE_USER_DIR`，默认用户目录 `.deviceforge`；`--data-dir` 只改变业务数据与旧兼容部署目录。清除 npm 缓存不删除这些持久内容，但再次 npx 启动可能需要联网获取宿主。包格式与生命周期见 [cli/README.md](cli/README.md)，后端部署说明见 [命令行部署与插件安装](backend/docs/guides/命令行部署与插件安装.md)。

`npm run pack:plugins` 生成原生组件 TGZ，可用 `npm run pack:plugins -- msgpack` 选择插件 ID。完整发布还须通过 `pack:plugin-release` 组合组件与工具，形成用户一次安装的市场条目及离线 ZIP。便携目录、独立 TGZ 和 npm 包保留在 `plugin install-legacy` / `plugin list-legacy`，它们不自动准备工具，不覆盖完整发布拥有的组件。分发说明见 [开发者发布工具](scripts/plugin-releases/README.md) 和 [原生组件分发](backend/docs/implementation/原生插件分发.md)。

当前 Windows x64 release 运行包已重建，真实 npx 验证默认免令牌与可选鉴权、五个原生插件、运行中热装卸、日志关联及正常退出。本阶段增加公开 Node 设备示例的实际安装、HTTP/MCP 发现与能力调用、重载换代、两种传输的旧引用拒绝，以及完整任务和事件历史保留。包内 `runtime/web/assets/plugin-host.js` 导出 `createFrontendRuntime` 与 `createNamedSlotAdapter`，提供可独立导入的生产宿主入口；应用用例与插件 SDK 的具体能力见前端文档。

协议 2/3 设备插件可通过 `artifacts.input_pointers` 选择嵌套业务参数中的产物 ID，例如 `/input/artifact_id`；宿主提前校验、准备摘要一致的独立副本，并发布输出文件。debug/release 真实服务及同一 tgz 的 npx 两协议安装、HTTP/独立 MCP、副本与输出、在途卸载和历史验收已通过，见 [插件产物协议](backend/docs/contracts/插件产物协议.md)。Android/Harmony 仍待迁出宿主。

平台迁出的首步已交付独立 [异步工具执行库](backend/crates/tool-process/README.md)，提供 argv、环境、字节/文件输出、限额、绝对截止时间和有界直接进程回收。宿主已经回接，非合作插件清理失败或执行 Future 丢弃保留未确认状态。当前后端 248 项测试、debug/release 运行及真实 npx 通过；实际平台插件、旧操作统一准入和性能会话热卸载继续按 [迁出方案](backend/docs/implementation/平台适配器迁出实施.md) 实施。

尚未发布 npm registry，`npx @deviceforge/cli` 的在线启动仍待公开发布。其他平台、另一台局域网客户端、真机与具体产品视觉需要独立验收；平台适配器迁出、常驻会话、Frida、自动化、投屏等仍按迁移清单推进。

