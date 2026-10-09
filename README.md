# DeviceForge · 设备工坊

浏览器 / 服务器架构重写工程。Rust 后端优先实施；Svelte 浏览器端本阶段只提供基础文件骨架和开发者扩展契约。

后端入口：backend/README.md。后端文件骨架、开发约束、接口设计、MCP 服务及核心迁移清单全部存放在 backend/docs。

前端入口：frontend/README.md。前端架构、开发约束和浏览器插件契约独立存放在 frontend/docs。

独立工程位于 `G:\Rust\DeviceForge`，旧 Electron 工程只作业务行为对照。新架构采用可替换端口和适配器，通过公开操作贡献接入设备工具及独立进程插件，HTTP 和 MCP 共用任务层。内部 apk-* crate 名称暂保留。

当前实现：分层工程、SQLite 任务与事件、输入模式验证、并发调度、取消恢复、HTTP / OpenAPI、MCP、进程插件、受控产物、基础设备操作、安装包分析及性能会话。Frida、投屏及完整业务迁移仍在后续范围，具体以 backend/docs/迁移清单.md 为准。

Rust 服务使用 Tokio + Axum 异步架构，线上任务与性能存储通过受限阻塞工作池执行。日志采用有界非阻塞 JSONL、轮转/保留和退出刷新；v2 HTTP、MCP、后台任务与插件调用携带关联日志 ID，v1 保留兼容。公开契约见 [日志与关联契约](backend/docs/日志与关联契约.md)，前端消费要求独立放在 [日志 ID 与接口消费](frontend/docs/日志ID与接口消费.md)。通用进程插件支持运行中加载/卸载/重载，设备适配器文档仍是候选方案，公开设备提供者和常驻设备热拔插尚未实施。

开发要求分别见 [backend/AGENTS.md](backend/AGENTS.md) 和 [frontend/AGENTS.md](frontend/AGENTS.md)，两份文件独立包含职责、依赖、资源与检查要求。启动器另遵守 [cli/AGENTS.md](cli/AGENTS.md)，根目录只保存共同规则和工程导航。

## 本地 npx 启动

构建者执行 `npm run pack:cli` 生成当前平台运行包；使用者只需 Node.js 22.18 或更高版本及 npm。包携带预编译 Rust 后端、离线插件校验器和前端静态资源。配置环境变量 `APK_API_TOKEN` 后，在项目根目录执行：

```powershell
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge start --ip 0.0.0.0 --port 7030 --mcp-port 7032
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge plugin install .\my-plugin
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge plugin list
```

默认允许局域网访问，前端/API 使用 7030，独立 MCP 使用 7032；可分别指定 IP 和端口。数据默认位于用户目录 `.deviceforge`，可用 `--data-dir` 修改。服务器插件安装支持便携本地目录、tgz 与 npm 包名，运行中安装后通过鉴权 HTTP/MCP 显式加载。包格式与生命周期见 [cli/README.md](cli/README.md)，后端部署说明见 [命令行部署与插件安装](backend/docs/命令行部署与插件安装.md)。

`npm run pack:plugins` 为 echo、artifact_copy、msgpack、performance_demo 生成当前平台 release 插件 tgz，也可用 `npm run pack:plugins -- msgpack` 选择插件 ID。生成的包可直接交给上述 `plugin install`，开发者只维护 Cargo 与原有公开清单。分发说明见 [原生插件分发](backend/docs/原生插件分发.md)。

当前分发面向 Windows x64，本地 tgz 可用；尚未发布 npm registry，`npx @deviceforge/cli` 的在线启动仍待公开发布。其他平台、另一台局域网客户端及真机需要独立验收，前端仍是基础骨架。

