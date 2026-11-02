# DeviceForge · 设备工坊

**面向开发者与测试人员的可扩展设备调试工作台。**

DeviceForge 将设备管理、应用分析、性能采集与自动化放进同一个浏览器工作台。设备和外部工具运行在 Rust 服务器一侧，浏览器负责交互；HTTP 与 MCP 客户端复用同一套任务能力。通过服务器插件和浏览器插件，可以同时扩展底层工具与产品界面。

[快速开始](#快速开始) · [插件扩展](#插件扩展) · [接入 MCP](#接入-mcp) · [开发与文档](#开发与文档) · [参与贡献](#参与贡献)

> 项目处于活跃开发阶段，接口与插件体系仍在迭代。目前运行包的验证主要覆盖 Windows x64；其他平台、设备型号和具体业务能力需要分别验证。当前使用本地构建的 `.tgz` 包启动，暂不以 `npx @deviceforge/cli` 作为可用安装入口。

## 核心能力

| 方向 | 可以做什么 |
| --- | --- |
| 设备调试 | 通过设备提供者接入 Android / HarmonyOS，管理设备与应用，使用截图、输入和视频投屏等能力 |
| 应用分析 | 查看 APK / AAB / APKS 信息，进行签名检查、反编译与安装包转换 |
| 性能诊断 | 采集 CPU、内存与 FPS，查看归档、调用栈和火焰图；Root 采集取决于设备资格与工具支持 |
| 自动化与调试 | 通过相关插件接入设备步骤、桌面操作、终端与 Frida 等工作流 |
| 插件扩展 | 安装、启停与更新服务器插件和浏览器插件，扩展页面、组件、命令及服务 |
| 程序化调用 | 通过 HTTP API 或 MCP 调用公开能力，查询任务、事件与产物，并用日志 ID 追踪问题 |

具体可用能力以当前安装的插件、操作目录与设备支持为准，不代表两个设备平台具有相同能力。视频投屏当前不含音频。各模块的迁移与验证状态见[开发进度](docs/当前进度与新会话交接.md)。

## 快速开始

### 1. 准备环境

- Node.js **22.18 或更高版本**，以及 npm。
- 从源码构建时，需要支持 Rust 2024 edition 的稳定工具链，以及对应平台的编译工具；Windows 使用 MSVC 工具链时需要 C++ 构建工具。
- 使用设备能力时，按相关插件要求准备 ADB、HDC 或其他外部工具；启动工作台本身不要求连接设备。

已有可信来源提供的、匹配本机平台的 CLI 运行包时，可以跳过源码构建，直接从第 3 步启动；运行包使用者无需安装 Rust。

### 2. 从源码构建运行包

```sh
git clone https://github.com/CitricAcidCandy/DeviceForge.git
cd DeviceForge
npm ci
npm run pack:cli
```

构建脚本会编译 Rust 后端、安装前端依赖并构建静态资源，随后在 `artifacts/` 下生成 CLI 包。包内包含后端、插件校验器和浏览器资源，**仅适用于构建主机的平台与架构**。

### 3. 启动工作台

在项目根目录执行；使用其他版本或外部提供的运行包时，替换为实际包路径：

```sh
npx --yes --package ./artifacts/deviceforge-cli-0.1.0.tgz deviceforge start
```

首次启动使用以下默认值；已有根配置或命令行参数可以覆盖它们：

| 入口 | 默认地址 |
| --- | --- |
| 浏览器工作台与 HTTP API | <http://127.0.0.1:7030> |
| 独立 MCP 端点 | <http://127.0.0.1:7032/mcp> |

默认监听 `0.0.0.0`，同一局域网的同事可通过服务器 IP 访问。只允许本机访问时，在启动命令末尾增加 `--ip 127.0.0.1`；端口可用 `--port` 和 `--mcp-port` 调整。在运行终端按 **Ctrl+C** 请求正常停止。

> DeviceForge 面向个人与可信同事的局域网环境，默认免鉴权。需要令牌时，可在启动前设置 `APK_API_TOKEN`，客户端使用 Bearer 令牌。插件按可信代码运行，不提供强制沙箱隔离；请仅安装可信来源的插件，不要将默认部署直接暴露到公网。

## 插件扩展

DeviceForge 的扩展分为两侧：

- **服务器插件**：提供工具、任务、设备能力或后台服务，由宿主管理进程与生命周期。
- **浏览器插件**：提供页面、组件、命令与服务，通过公开接口接入工作台，也可以向其他插件的扩展点贡献内容。

同一个功能可以包含配套的服务器与浏览器组件，以完整发布包统一安装。独立插件工程以一份 `manifest.json` 描述功能、组件、依赖和市场资料，由 CLI 生成分发文件，不必重复手写多套清单。

### 安装插件

工作台启动后，可在插件市场使用“从本地导入”导入完整离线 ZIP，也可以在另一个终端调用 CLI。以下以 `my-plugin.zip` 为例，请替换为实际插件包路径：

```sh
npx --yes --package ./artifacts/deviceforge-cli-0.1.0.tgz deviceforge plugin install ./my-plugin.zip --api-url http://127.0.0.1:7030
npx --yes --package ./artifacts/deviceforge-cli-0.1.0.tgz deviceforge plugin list --api-url http://127.0.0.1:7030
```

安装命令连接已经运行的服务，不会启动另一个后端。账号、路径或其他必要输入尚未配置时，需要在市场补齐配置；安装状态与运行状态以服务实际返回为准。更多打包、安装与更新用法见 [CLI 指南](cli/README.md)。

### 自建插件市场（可选）

资源服务负责保存插件包、依赖与市场资料，与工作台独立部署。在源码根目录启动：

```sh
npm run start:resource-server
```

默认地址为 <http://127.0.0.1:7040>。启动工作台时可用 `--marketplace-url` 指向其他资源服务，或用 `--marketplace-config` 配置多个来源。资源服务不随 CLI 打包或自动启动，**本地离线插件导入不依赖它**。局域网监听、存储与发布流程见[资源服务指南](resource-server/README.md)。

## 接入 MCP

支持 Streamable HTTP 的 MCP 客户端可以连接启动后的独立端点：

```text
http://127.0.0.1:7032/mcp
```

局域网客户端将 `127.0.0.1` 替换为服务器 IP；自定义了 MCP 端口时使用实际端口。如果服务配置了 `APK_API_TOKEN`，客户端需要发送 `Authorization: Bearer <令牌>` 请求头。

MCP 与浏览器共用任务、事件、产物和日志体系，不需要再部署一套设备服务。插件作者还可调用 `get_plugin_development_guide` 获取公开开发指南与示例，无需读取宿主源码。工具说明与接入细节见 [MCP 服务文档](backend/docs/guides/MCP服务.md)。

## 数据与配置

数据保存在服务器一侧，默认用户目录为 `~/.deviceforge`，Windows 对应 `%USERPROFILE%\.deviceforge`。

| 内容 | 配置方式 |
| --- | --- |
| 业务数据 | `--data-dir` 或 `DEVICEFORGE_DATA_DIR` |
| 统一安装的插件、共享工具与插件配置 | `DEVICEFORGE_USER_DIR`，默认使用服务器用户的 `.deviceforge` 目录 |
| 日志 | 默认位于业务数据目录的 `logs/`，可用 `DEVICEFORGE_LOG_DIR` 调整 |
| 监听地址与市场来源 | 业务数据目录的 `config.json`；命令行参数只覆盖本次启动 |

`--data-dir` 不改变统一安装的插件、共享工具和插件配置的归属。清理 npm 缓存不会主动删除这些持久内容。完整配置、目录规则与兼容部署说明见 [CLI 指南](cli/README.md)。

## 开发与文档

后端采用 **Rust + Tokio + Axum**，前端采用 **React + TypeScript + Vite + Tailwind CSS**。设备操作与外部进程由服务器执行，浏览器通过公开契约消费能力；资源服务作为独立组件维护。

| 目录 / 入口 | 内容 |
| --- | --- |
| [backend/](backend/README.md) | Rust 宿主、HTTP / MCP、任务系统与服务器插件 |
| [frontend/](frontend/README.md) | 浏览器工作台、界面组件与浏览器插件 |
| [cli/](cli/README.md) | 运行包启动、插件打包与安装 |
| [resource-server/](resource-server/README.md) | 独立资源存储与插件市场 |
| [examples/](examples/) | 插件与集成示例 |
| [后端文档](backend/docs/README.md) / [前端文档](frontend/docs/README.md) | 所属端的架构、接口、开发与验证说明 |
| [开发进度](docs/当前进度与新会话交接.md) | 当前实现状态、验证范围与待完成项 |

需要修改源码时，先阅读[共同开发要求](AGENTS.md)，再阅读对应的[后端](backend/AGENTS.md)、[前端](frontend/AGENTS.md)或 [CLI](cli/AGENTS.md) 约束。开发服务的启动方式与热更新说明以各模块文档为准，不与上述 CLI 运行包的端口配置混用。

## 参与贡献

欢迎通过 [Issues](https://github.com/CitricAcidCandy/DeviceForge/issues) 反馈问题、讨论功能，或提交 [Pull Request](https://github.com/CitricAcidCandy/DeviceForge/pulls) 改进代码、文档与示例。

- **反馈问题**：提供版本、操作系统、相关插件与设备信息，附上复现步骤、预期行为及脱敏后的日志 ID 或日志片段。
- **提交修改**：保持改动聚焦，遵守所属模块的开发约束，并为行为变化补充直接相关的测试。
- **说明验证**：在 Pull Request 中写清改动动机、影响范围、实际执行的验证与已知限制；未验证的平台或设备不要标为支持。

请勿提交访问令牌、签名密钥、账号凭据或未经脱敏的设备数据。

## 许可证

项目的[包元数据](package.json)声明使用 **MIT** 许可证。当前仓库尚未附带 `LICENSE` 正文，许可文件仍待补齐。
