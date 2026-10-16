# 服务器插件打包与部署

服务器插件交付自包含的 ZIP 或 npm TGZ。安装器校验包、公开清单和当前平台入口，生成受控部署，不运行 npm 生命周期脚本或替插件下载依赖。Node 依赖应先打包进浏览器无关的服务器入口；原生插件应先编译目标平台可执行文件。

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

## 在线安装与加载

当前产品“插件”页选择服务器插件，上传 ZIP/TGZ，核对 ID、版本与运行状态，再启用。部署成功仅表示包已安装；加载会注册操作和能力，之后才能调用。浏览器插件停用不会自动卸载配套服务器插件，反之亦然。

HTTP 管理使用 `GET /api/v2/plugins`、`POST /api/v2/plugins/{id}/load`、`POST /api/v2/plugins/{id}/unload`；MCP 对应 `deviceforge.list_plugins`、`deviceforge.load_plugin` 和 `deviceforge.unload_plugin`。只向加载/卸载接口提供插件 ID，不传本机程序或任意目的目录。部署者配置可选令牌时按现有鉴权规则使用，令牌不进入包或提示词。

本项目 CLI 的插件安装支持本地 TGZ；以部署者实际提供的 CLI 包或源码命令帮助为准，不假设 `@deviceforge/cli` 已发布到公共 registry。安装完成后运行中的服务仍须显式加载；初次服务启动可从部署目录加载已安装包。

## 更新与回收

同 ID 包更新不能绕过运行保护直接覆盖文件。先卸载旧运行代次并查询实际状态，确认退出与清理后再按当前部署 API 删除旧包、安装新包、加载并验证。取消管理请求只撤销客户端等待，管理工作可能继续，应重新查询而非自动重放。

卸载撤销新入口并等待在途工作；`draining/cleanup_failed` 表示资源未确认，此时不能把杀掉直接进程或重启页面作为清理完成。历史任务与发布产物按宿主策略保留。新代际不接受旧设备引用、旧调用结果或缓存的私有上下文。
