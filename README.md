# DeviceForge · 设备工坊

浏览器 / 服务器架构重写工程。Rust 后端优先实施；浏览器端实现通信、基础用例与可热装卸插件框架，具体界面和 UI 框架等待设计稿。

后端入口：backend/README.md。后端文件骨架、开发约束、接口设计、MCP 服务及核心迁移清单全部存放在 backend/docs。

前端入口：frontend/README.md。前端架构、开发约束和浏览器插件契约独立存放在 frontend/docs。

独立工程位于 `G:\Rust\DeviceForge`，旧 Electron 工程只作业务行为对照。新架构采用可替换端口和适配器，通过公开操作贡献接入设备工具及独立进程插件，HTTP 和 MCP 共用任务层。内部 apk-* crate 名称暂保留。

当前实现：分层工程、SQLite 任务与事件、输入模式验证、并发调度、取消恢复、HTTP / OpenAPI、MCP、进程插件、受控产物、基础设备操作、安装包分析及性能会话。Frida、投屏及完整业务迁移仍在后续范围，具体以 backend/docs/迁移清单.md 为准。

Rust 服务使用 Tokio + Axum 异步架构，线上任务与性能存储通过受限阻塞工作池执行。日志采用有界非阻塞 JSONL、轮转/保留和退出刷新；v2 HTTP、MCP、后台任务与插件调用携带关联日志 ID，v1 保留兼容。公开契约见 [日志与关联契约](backend/docs/日志与关联契约.md)，前端消费要求独立放在 [日志 ID 与接口消费](frontend/docs/日志ID与接口消费.md)。通用进程插件支持运行中加载/卸载/重载。公开离散设备提供者、能力路由与前端设备上下文已实现，当前 debug/release 设备、真实浏览器及 npx 分发集成通过；平台实现迁出宿主、常驻连接与真机尚未完成。

本地/同事局域网默认免鉴权，APK_API_TOKEN 可选，配置后执行令牌检查。在线插件按可信代码运行，不要求权限审批或强制隔离。浏览器可在线提交服务器包与浏览器包并热装卸；公开组件、模块、命令、服务、状态和任务提交钩子已接入运行平台。真实浏览器已使用生产宿主入口验证两类上传、动态依赖、服务器调用、界面替换及停用恢复：[后端在线安装架构](backend/docs/在线插件安装架构.md)、[前端在线插件与开放扩展](frontend/docs/在线插件与开放扩展.md)。具体产品界面仍等待设计稿。

开发要求分别见 [backend/AGENTS.md](backend/AGENTS.md) 和 [frontend/AGENTS.md](frontend/AGENTS.md)，两份文件独立包含职责、依赖、资源与检查要求。启动器另遵守 [cli/AGENTS.md](cli/AGENTS.md)，根目录只保存共同规则和工程导航。

## 本地 npx 启动

构建者执行 `npm run pack:cli` 生成当前平台运行包；使用者只需 Node.js 22.18 或更高版本及 npm。包携带预编译 Rust 后端、离线插件校验器和前端静态资源。在项目根目录执行；如需鉴权再配置 `APK_API_TOKEN`：

```powershell
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge start --ip 0.0.0.0 --port 7030 --mcp-port 7032
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge plugin install .\my-plugin
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge plugin list
```

默认允许局域网访问，前端/API 使用 7030，独立 MCP 使用 7032；可分别指定 IP 和端口。数据默认位于用户目录 `.deviceforge`，可用 `--data-dir` 修改。服务器插件安装支持便携本地目录、tgz 与 npm 包名，运行中安装后通过 HTTP/MCP 显式加载；配置令牌时携带鉴权。包格式与生命周期见 [cli/README.md](cli/README.md)，后端部署说明见 [命令行部署与插件安装](backend/docs/命令行部署与插件安装.md)。

`npm run pack:plugins` 为 echo、artifact_copy、msgpack、performance_demo、cooperative_demo 生成当前平台 release 插件 tgz，也可用 `npm run pack:plugins -- msgpack` 选择插件 ID。生成的包可直接交给上述 `plugin install`，开发者只维护 Cargo 与原有公开清单。在线上传要求包自包含运行依赖；安装与启用是独立操作。分发说明见 [原生插件分发](backend/docs/原生插件分发.md)。

当前 Windows x64 release 运行包已重建，真实 npx 验证默认免令牌与可选鉴权、五个原生插件、运行中热装卸、日志关联及正常退出。本阶段增加公开 Node 设备示例的实际安装、HTTP/MCP 发现与能力调用、重载换代、两种传输的旧引用拒绝，以及完整任务和事件历史保留。包内 `runtime/web/assets/plugin-host.js` 导出 `createFrontendRuntime` 与 `createNamedSlotAdapter`，提供可独立导入的生产宿主入口；应用用例与插件 SDK 的具体能力见前端文档。

协议 2/3 设备插件可通过 `artifacts.input_pointers` 选择嵌套业务参数中的产物 ID，例如 `/input/artifact_id`；宿主提前校验、准备摘要一致的独立副本，并发布输出文件。debug/release 真实服务及同一 tgz 的 npx 两协议安装、HTTP/独立 MCP、副本与输出、在途卸载和历史验收已通过，见 [插件产物协议](backend/docs/插件产物协议.md)。Android/Harmony 仍待迁出宿主。

平台迁出的首步已交付独立 [异步工具执行库](backend/crates/tool-process/README.md)，提供 argv、环境、字节/文件输出、限额、绝对截止时间和有界直接进程回收。宿主已经回接，非合作插件清理失败或执行 Future 丢弃保留未确认状态。当前后端 248 项测试、debug/release 运行及真实 npx 通过；实际平台插件、旧操作统一准入和性能会话热卸载继续按 [迁出方案](backend/docs/平台适配器迁出实施.md) 实施。

尚未发布 npm registry，`npx @deviceforge/cli` 的在线启动仍待公开发布。其他平台、另一台局域网客户端、真机与具体产品视觉需要独立验收；平台适配器迁出、常驻会话、Frida、自动化、投屏等仍按迁移清单推进。

