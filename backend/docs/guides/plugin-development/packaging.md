# 服务器插件打包与部署

服务器插件交付自包含的 ZIP 或 npm TGZ。安装器校验包、公开清单和当前平台入口，生成受控部署，不运行 npm 生命周期脚本或替插件下载依赖。Node 依赖应先打包进浏览器无关的服务器入口；原生插件应先编译目标平台可执行文件。

当前推荐将这些独立组件包和工具一起编排为完整功能发布；下文先解释底层服务器包，最后给出统一在线与离线流程。外层 `release.json` 不改变 `package.json.deviceforge.kind:"server"`，浏览器包仍为 `kind:"browser"` 与 SDK v2 ESM。

## 包目录与入口

最小 Node 示例目录为：

```text
guide-echo/
  package.json
  plugin.json
  entry.mjs
```

`package.json.deviceforge` 声明 `kind:"server"`、`manifest:"plugin.json"` 和 `entrypoints.any:{runtime:"node",path:"entry.mjs"}`。便携 `plugin.json` 不写 `executable`；安装器为 Node 入口配置运行时及参数，为原生入口选择目标平台二进制。`runtime:"native"` 的入口应按 `win32-x64`、`linux-x64` 等部署目标声明，不以本机生成文件冒充跨平台包。

包名与插件 ID 是不同概念；安装身份来自清单 `id`。包版本、清单版本必须一致；浏览器配套包使用独立身份和 `kind:"browser"`，不能混成一种部署。

## 生成与核对归档

在 `examples` 主题中提供的完整 Node 示例目录运行：

```powershell
node --check entry.mjs
npm pack --ignore-scripts --dry-run --json
npm pack --ignore-scripts
```

核对实际 TGZ 的文件清单，确保包含 `package.json`、`plugin.json`、入口及所有相对依赖。npm TGZ 自带 `package/` 外层，但清单内路径仍相对于包根，不加 `package/`。ZIP 推荐将这三个文件直接放归档根；归档层级、链接、路径、大小和清单仍要通过安装器检查。不要附带凭据、设备数据、Git 历史、开发机工具路径或无关构建缓存。

## 旧单组件安装与加载兼容

旧独立部署可通过兼容安装入口上传服务器 ZIP/TGZ，核对 ID、版本与运行状态，再加载。部署成功仅表示包已安装；加载会注册操作和能力，之后才能调用。统一发布所属组件必须通过统一安装管理，不能拆分使用本节入口更新或启停。

HTTP 管理使用 `GET /api/v2/plugins`、`POST /api/v2/plugins/{id}/load`、`POST /api/v2/plugins/{id}/unload`；MCP 对应 `deviceforge.list_plugins`、`deviceforge.load_plugin` 和 `deviceforge.unload_plugin`。只向加载/卸载接口提供插件 ID，不传本机程序或任意目的目录。部署者配置可选令牌时按现有鉴权规则使用，令牌不进入包或提示词。

本项目 CLI 的插件安装支持本地 TGZ；以部署者实际提供的 CLI 包或源码命令帮助为准，不假设 `@deviceforge/cli` 已发布到公共 registry。安装完成后运行中的服务仍须显式加载；初次服务启动可从部署目录加载已安装包。

## 旧独立部署更新与回收

同 ID 包更新不能绕过运行保护直接覆盖文件。先卸载旧运行代次并查询实际状态，确认真实在途工作退出及待变更文件可用后，再按当前部署 API 删除旧包、安装新包、加载并验证；不要求全插件历史清理告警归零。取消管理请求只撤销客户端等待，管理工作可能继续，应重新查询而非自动重放。

卸载撤销新入口并有界等待真实在途工作；`draining` 与历史 `cleanup_failed` 分开处理。旧告警不冻结独立新调用或排空后的重载，真实占用、共享工具引用或文件事务异常只限制对应变更；规则见[资源故障隔离与后台回收裁定](../../implementation/资源故障隔离与后台回收裁定.md)。杀掉直接进程或重启页面不能作为外部资源清理完成的证据。历史任务与发布产物按宿主策略保留。新代际不接受旧设备引用、旧调用结果或缓存的私有上下文。

## 完整发布、市场和离线

用项目发布器将组件 ZIP/TGZ 和实际工具字节编排成 `release.json`：源码版本范围仅用于选择输入，成品必须固定版本、大小、SHA-256、平台与稳定工具 entries。离线 ZIP 根直接包含 `release.json`，所有 path 引用的资源在包内（例如 `blobs/<sha256>`），完整闭包不能遗漏，不下载缺失依赖。在线清单 path 改为同资源服务器的相对摘要，并重新计算原始清单修订，不能复用离线清单摘要。

网页发布前 GET `/api/v1/capabilities`，要求 `api_version:1`、`release_publication.format_versions` 含 1、`host_api_versions` 含 2、`catalog_last:true`、`immutable_versions:true`，并遵守 `resource_max_bytes`（当前 2147483648）。缺接口或能力不兼容时提示升级，停止写入资源；不能试探性向旧服务器上传。HEAD `/api/v1/resources/{sha256}` 核对现有摘要和长度，缺失才 POST `/api/v1/resources`，组件/工具全部完成后上传在线清单，最后 POST `/api/v1/catalog`。只产生一个可见 plugin 条目，`resource_id` 引用清单摘要，details 固定 `release_format_version:1,host_api_version:2`。

资源服务器校验 marker、清单身份和完整闭包，同 ID/版本禁止换清单，删除后身份仍保留。它不接收 ZIP 后解包发布；失败可能保留已上传资源，但不会入 catalog。发布与安装不同，远端资源上传不能证明插件已启用或业务可用。

宿主使用 `GET /api/v2/plugin-installations` 查询，`POST /api/v2/plugin-installations/plan` 计划，安装写操作返回需查询终态的任务。在线 source 为 `{kind:"market",source_url,release_id,version,manifest_sha256}`，来源必须处于宿主配置市场目录；离线先上传 `/api/v2/plugin-installations/artifacts?filename=包名.zip` 获得产物 ID，再用 `{kind:"offline",artifact_id}` 安装。更新、启停、卸载要求 `expected_revision`；卸载保留配置。

安装内容归宿主用户根的 `plugins/browser-plugins/tools/installations`，两端配置归 `plugin-configurations/server` 和 `browser`，根 config.json 不合并业务凭据。托管默认工具自动绑定，高级显式路径优先；旧 `APK_PLUGIN_DIR`、`APK_ADB`、`APK_HDC` 和旁置配置只保留原兼容语义，既有目录不自动搬迁。
