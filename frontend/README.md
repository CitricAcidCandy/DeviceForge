# DeviceForge 浏览器工程

## 作用与范围
Svelte 5、TypeScript 和 Vite 的独立浏览器工程。已实现 v2 客户端、操作/任务/服务器插件与设备第一阶段基础用例、两类在线包部署及热装卸、公开宿主与开放扩展注册表；保留开发阶段外壳，具体业务页面等待设计稿。

## 快速开始
使用 Node.js 22.18 或更高版本，执行 `npm ci`、`npm run dev`。开发代理将 `/api` 与 `/mcp` 转发至本机 7031。生产部署将静态产物和服务器配置为同源，避免在前端代码写死服务器地址。

统一 npx 运行包携带构建后的静态资源，对外默认前端/API 地址为 `http://服务器地址:7030`；可通过 CLI `--ip`、`--port` 修改。前端分发边界见 [静态分发与访问](docs/静态分发与访问.md)。本轮设备版本已重建 release runtime，并通过真实浏览器及 npx 验收。

验证：`npm run generate:api`、`npm run check`、`npm test`、`npm run build`。依赖锁文件提交到源码管理，CI 使用 npm ci。TypeScript 使用 5.9 兼容当前接口生成器和 Svelte 检查器，不通过忽略 peer 依赖强行升级。

## API 与参数
`src/app/index.ts` 公开 `createFrontendRuntime`；传入 baseUrl、fetch 传输及挂载目标，tokenProvider 可选，缺省不发送鉴权头。请求显式传 AbortSignal，返回 data/logId，错误受控分类；产物上传为 octet-stream，下载保留原字节。令牌不保存到 localStorage 或 URL。

构建公开生产入口 `/assets/plugin-host.js`，以原生 ESM 导出 `createFrontendRuntime` 和 `createNamedSlotAdapter`。宿主可从该入口装配传输、挂载目标/默认 renderer 和 ESM importer；包加载默认使用已安装资源的运行 UUID 路径。此入口独立于产品外壳：`main.ts` 尚未装配产品 runtime，不会自动连接服务、安装插件或生成业务页面。

SDK v2 在 `src/plugin-sdk/index.ts`，独立于生成 DTO。v1 插件须更新 apiVersion、显式信号与 HostResult。插件可贡献面板、具名组件槽（append/replace）、模块、命令、版本化服务及 beforeTaskSubmit 钩子；插件专属上下文提供事件/状态和动态贡献登记。HostContext 提供 listOperations/submit/getJob/cancelJob、操作目录订阅及可选 devices；插件 SDK 没有服务器插件管理、在线包管理或产物上传下载适配。`runtime.serverPlugins/pluginPackages/artifacts` 是宿主 app 用例入口，不会自动授予插件。

`runtime.devices` 已装配，`HostContext.devices` 以 apiVersion 2 的可选字段兼容旧宿主。公开方法为 refreshProviders/refreshDirectories/refreshProvider(id,generation,signal)/invoke(action,signal)、select/snapshot/subscribe；异步方法返回 HostResult。SDK DeviceRef 使用 providerId/generation/localId，DeviceAction 使用 providerId/generation/deviceId/capability/version/input，由 app 显式映射生成 HTTP 字段。刷新开始清本代旧观测与选择，失败保持空；切换设备、提供者代变或卸载拒绝旧结果。插件实例与面板/组件/模块的取消和订阅均随生命周期收敛。

本实例服务器插件 load/unload（含在线服务器包启停）后先撤销目标设备缓存与选择，再重查操作和设备目录；取消或重查失败也不保留旧缓存。远端变化需显式刷新，没有后台推送或常驻设备会话。

`runtime.pluginPackages` 提供 refresh/snapshot/subscribe/upload/enable/disable/remove。`upload(kind, Blob, mediaType, signal)` 中 kind 为 server/browser，mediaType 为 application/zip 或 application/gzip，对应必填 format=zip/tgz；上传只部署，enable 才执行。取消或失败后独立重查实际部署目录，不假定服务端回滚或自动重放。浏览器 remove 先停止本实例并撤销加载源，再删除部署；删除失败且目录仍存在时可重新 enable。

`webPlugins.register/load/mount/unload` 支持可信预注册；`registerInstalledPackage` 使用宿主注入的 ESM importer 和运行路径解析器。每次 load 的 UUID 放在资源路径中，使相对依赖也进入新代次；不只给入口加查询参数。模块由 extensions.mountModule(id) 进入，extensions.unmount(id) 退出子生命周期，重新进入可重挂载。任务钩子按 priority（默认 0）再 id 串行执行，失败停止后续钩子及本次 HTTP 提交，卸载后恢复剩余钩子或原流程。

服务器与浏览器运行状态独立。浏览器包删除不会强制停止同事其他浏览器中的实例，已执行 ESM 的内存缓存也无法卸出；新的运行路径用于避免重载复用旧依赖状态。可信代码未登记的全局副作用由插件负责，管理器不能强制终止不响应取消的 JavaScript。

## 文档
当前实现与文件职责见 [前端运行架构](docs/前端运行架构.md)，在线扩展边界见 [在线插件与开放扩展](docs/在线插件与开放扩展.md)，签名与生命周期见 [插件开发](docs/插件开发.md)。后端文档独立存于 backend/docs。

设备提供者第一阶段的目录、选择、能力准入与离散动作已实现，见 [前端实施](docs/设备提供者第一阶段实施.md)。[设备能力与插件面板](docs/设备能力与插件面板.md) 中的具体工作台交互仍待设计；本阶段不代表常驻设备热拔插、平台工具迁出或真机验收完成。

平台迁出的前端消费、设备引用、长安装与性能会话审核要求见 [平台适配器迁出边界](docs/平台适配器迁出边界.md)。公共工具库由后端使用，不新增浏览器本机命令接口；本步不修改前端类型或产品界面。

客户端默认只消费 v2，生成类型保留 v1；日志复制 UI 尚未实施。关联 ID 与原字节约束见 `docs/日志ID与接口消费.md`。

本端独立开发规则见 [AGENTS.md](AGENTS.md)，包含完整职责、严格类型、异步资源与检查要求。

[服务器插件生命周期消费](docs/服务器插件生命周期消费.md) 约束运行目录、代际、保护依赖及取消后查询。基础用例保留 cleanup_failed/draining。前阶段主代理已完成通用在线扩展的 debug/release 真实浏览器验收：生产公开 ESM 入口、两类包经 runtime.pluginPackages 上传/启停/删除、相对依赖新代、面板/组件替换/模块、命令/服务/状态、任务 hook 4→5 及停用恢复 4、DOM 清理与默认 renderer 恢复。历史 release 报告保留在根 artifacts/browser-plugin-smoke-release.json；debug 报告现已更新为下述设备阶段结果。历史在线扩展记录保留其当时范围，不扩为本轮设备 release/npx 验收。

本轮设备当前源码由主代理完成 check，退出 0（架构 49 文件、Svelte 0 错误/0 警告、TypeScript 通过），test 退出 0（73/73），production build 通过。根 artifacts/browser-plugin-smoke-debug.json 和 browser-plugin-smoke-release.json 的整体及 browser.passed 均为 true，publicDeviceCapability/deviceProviderGenerationChanged/oldDeviceReferenceRejected 均为 true。分发宿主与浏览器验收生产 ESM 的 SHA-256 一致；真实 npx 也已完成公开设备示例安装、HTTP/MCP 调用与旧代拒绝。上述证据不包含远端推送、常驻会话、真机、产品 UI 或生产容量，main.ts 仍未装配产品 runtime。
