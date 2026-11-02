# 独立工作区贡献插件

这是第二个独立工程，只通过公开扩展点和版本化服务与 `workspace_suite` 配合。它不导入另一插件的工程，不要求对方先加载，不读取宿主源码，也不新增界面、样式或后台进程。

## 独立开发

需要 Node.js 22.18 或更高版本，以及 npm。复制整个目录后，在该目录执行：

```powershell
npm install
if ($LASTEXITCODE -ne 0) { throw "安装依赖失败" }
npm test
if ($LASTEXITCODE -ne 0) { throw "直接单元失败" }
npm run check
if ($LASTEXITCODE -ne 0) { throw "严格类型检查失败" }
```

开发依赖指向随附的真实 SDK TGZ，不是假定 registry 包。测试直接加载该归档的 ESM，无宿主别名。`npm run build` 通过公开 `@deviceforge/plugin-tools` 的 `buildBrowserPlugin` 构建浏览器入口，依赖路径来自已安装 SDK 发行包的 `import.meta.resolve`。当前工具 `0.1.1` 真实归档已随附在 `vendor/`，22640 字节、SHA256 `7b0dcc49beab4c5f7f9f3526adae5ec4853dc005bb6730a39e78f4e17fff2b9f`；旧工具文件保留作历史，不再作为依赖。不使用宿主内部构建脚本，未构建的源码仍不能当成安装包。

本插件没有可见 UI 或自有样式，入口不调用 `styles.js`；清单只收录实际运行的 `index.js`，不把未引用的构建报告和样式模块假称为业务依赖。

唯一清单是 `manifest.json`；整体与单浏览器组件均为 `workspace_contributor@0.1.0`。`package.json` 不重复维护插件身份和版本。默认导出工厂接收宿主注入的身份。

## 精确公开契约

提供者浏览器身份为 `workspace_suite.browser`，以下服务及扩展点的精确版本都是 `1`：

| 对象 | 标识 |
| --- | --- |
| 目标扩展点 | `workspace_suite.browser.tools` |
| 自有贡献 | `workspace_contributor.reader` |
| 服务依赖 | `workspace_suite.browser.message.read` |
| 服务依赖 | `workspace_suite.browser.normalize` |
| 根状态命令 | `workspace_contributor.status` |
| 功能内读取命令 | `workspace_contributor.read-provider` |
| 功能内规范化命令 | `workspace_contributor.normalize` |

贡献数据为 `{ title: "读取配套示例数据", commandId: "workspace_contributor.read-provider" }`。提供者不在时贡献处于等待，根状态命令仍能返回贡献和功能诊断；示例不会伪造提供者或把等待显示成成功。

读取命令和状态命令只接受 `{}`。规范化命令转调套件的公开浏览器服务，输入 `{ "message": "待规范化的消息" }`。服务的 Job 查询、未知结果和取消边界由提供者的公开适配负责；本插件不增加第二条 HTTP 请求或执行管线。

## 功能级装卸

`services.whenAvailable` 只包住依赖相关功能，命令登记使用它传入的功能子上下文。根状态命令和根扩展点贡献位于独立的插件作用域。

提供者卸载或换代会撤销相关功能及调用资格；旧结果即使晚到，也不能增加新功能的完成计数。提供者恢复后建立新的功能作用域，不自动重放过去的规范化命令。独立状态入口不因旧功能清理或提供者缺失而丢失。

## 实际安装后的检查顺序

1. 先加载此贡献插件，通过根状态命令读取等待状态。
2. 加载 `workspace_suite` 的浏览器组件，等待两个依赖服务可用。
3. 查看套件的扩展点目录，确认贡献处于可用状态；显式运行读取或规范化命令。
4. 卸载套件，确认相关命令撤销，而根状态命令继续可用。
5. 重新加载套件，确认新功能可用，旧结果不计入新功能，业务命令没有自动执行。

以上仍是待执行的在线验收说明。当前已完成公开端口单元、随附声明严格类型检查、独立依赖安装、浏览器构建和单清单打包。另有实际归档经原运行内核的装卸直接单元；尚未安装到运行中的宿主，不代表在线热装卸、浏览器、外部 Agent 或设备验收。

## 随附发行物

`vendor/deviceforge-plugin-sdk-0.1.0.tgz`：

- 字节数：`18091`。
- SHA256：`7f58a502a553cadf19f7cf884d987f8d0e5f867af1b77299939ba6ce0db370a5`。
- 实际本地开发包，未声称 registry 已发布。

当前依赖为上文 `vendor/deviceforge-plugin-tools-0.1.1.tgz`；旧 `0.1.0` 文件保留但不再作为本工程依赖，所有版本均未发布到registry。

2026-10-29 独立拷贝工程真实完成离线安装、浏览器构建及完整清单打包。该次 `workspace_contributor-0.1.0-win32-x64.zip` 为4486字节，SHA256 `078552078311de0a2e75dabbba48dae68c670766cd4d9ec59e545dc6a99645a2`，使用前批14599字节工具归档（SHA256 `fdfb3f63bb7841bdb937f2ec94c96e6a2259e1ecb739392d4214dc32dd025784`）。

2026-10-30 工具升为 `0.1.1` 后已在另一独立目录重新安装116包、严格类型检查、构建及打包；业务未改，真实新ZIP仍为4486字节且摘要相同，不是直接复制旧ZIP代替重新打包。配套最终归档9项直接单元通过，包含原内核装卸、真实服务器协议和注入HTTP对端的调试桥；在线安装、外部MCP与业务运行仍未验收。
