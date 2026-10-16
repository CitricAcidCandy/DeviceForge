# 浏览器插件打包与部署

浏览器插件交付已编译的 ESM 与包内资源，安装器不会替第三方包运行 npm install、构建或生命周期脚本。原生 JavaScript 可以直接作为入口；TypeScript、TSX、React 等先在开发环境构建，再把可浏览器执行的产物和依赖一起打包。不要依赖宿主私有 import 路径、Node 内置模块或浏览器无法解析的裸包名。

## 推荐包结构

```text
browser-guide-example/
  package.json
  plugin.json
  src/
    index.js
```

React 或 TypeScript 构建后可将入口改成 `dist/index.js`，相应修改 `deviceforge.entrypoints.any.path` 和 `files`。`plugin.json` 必须真实进入归档，单有源码目录或开发机上的相对链接不够。所有清单与文档使用 UTF-8，文件路径使用包内相对路径。

## npm TGZ

在插件自己的目录运行：

```powershell
node --check src/index.js
npm pack --ignore-scripts --dry-run --json
npm pack --ignore-scripts
```

`--dry-run --json` 用于核对文件清单；最终以实际 TGZ 内容为准。`npm pack` 的标准外层是 `package/`，内部 `package.json` 的 `manifest/path` 仍相对包根，例如 `plugin.json` 和 `src/index.js`，不附加 `package/`。

`--ignore-scripts` 避免打包时隐式执行脚本，但不会替你生成尚未构建的文件。如果需要构建，先显式运行经过核对的构建命令，再 pack。打包输出文件名由 npm 包名与版本决定，不能以文件名替代清单身份验证。

## ZIP

也可使用 ZIP 交付相同包内容。推荐将 `package.json`、`plugin.json` 与入口目录放在归档的包根；避免额外套入随意命名的工程目录。不要上传整个 node_modules、Git 历史、凭据、设备数据或本机构建缓存。ZIP/TGZ 均需通过宿主的路径、包身份、清单、入口和大小检查，扩展名本身不保证可以安装。

## 安装、启用与更新

1. 在当前宿主的插件管理页选择浏览器包类型并上传 ZIP/TGZ。
2. 上传成功表示部署文件已安装；核对返回的插件 ID、版本和入口。
3. 对当前浏览器实例启用插件，等待模块校验与激活成功。
4. 在插件页选择面板或模块进行挂载，验证真实业务。
5. 关闭挂载或停用插件，确认 DOM、订阅、命令和资源收敛。

安装和运行启用是两个动作。服务器包也有自己的安装与启停，不能因浏览器插件成功启用就假设后端能力已就绪。插件 SDK 没有包管理、服务器插件管理或服务令牌字段；这些属于宿主管理界面与 runtime 用例。

同 ID 包不直接覆盖。更新时先停用并删除旧部署，再上传新版，核对版本并重新启用。管理请求的等待取消后应重新查询实际安装和运行状态，不能假设变更回滚或自动重放。删除共享部署也不能强制停止其他同事浏览器中的既有实例。

## 资源与局域网

包内模块使用 `./helper.js` 等相对导入；资源以模块 URL 为基准，例如 `new URL('./data.json', import.meta.url)`。实际加载路径包含独立运行段，包内相对依赖随同换代；绝对资源地址或固定跨包导入不会自动继承该生命周期。

局域网 HTTP 页面可能不是安全上下文；使用 `crypto.randomUUID`、剪贴板、文件系统等浏览器 API 前检测支持情况。生成本地运行标记不代表鉴权。默认免鉴权部署和可选令牌部署共用插件包，凭据由宿主处理，不能写入包、提示词、URL、localStorage 或报错输出。
