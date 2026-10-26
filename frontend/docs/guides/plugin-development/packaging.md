# 浏览器插件打包与部署

浏览器插件交付已编译的 ESM 与包内资源，安装器不会替第三方包运行 npm install、构建或生命周期脚本。原生 JavaScript 可以直接作为入口；TypeScript、TSX、React 等先在开发环境构建，再把可浏览器执行的产物和依赖一起打包。不要依赖宿主私有 import 路径、Node 内置模块或浏览器无法解析的裸包名。

推荐以 `release.json` 将浏览器组件、服务器组件和工具打成一个完整功能发布。下文组件归档仍是独立 `kind:"browser"` 包；外层成套管理不将两类组件合成同一种格式或同一个入口。

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

## 样式与界面依赖

插件可以自带 React、自带 Tailwind、自带任意 CSS，宿主不会替它编译，也不会拦它。包内 CSS 与图片和入口放在同一份归档里，加载器按扩展名发 `text/css`、`image/webp` 等正确 MIME，插件用 `new URL('./index.css', import.meta.url)` 取到自己的样式表再插进文档即可。宿主的 Tailwind 只扫宿主自己的源码，所以**宿主不会替插件生成任何类**；这不是限制，插件自己构建时把用到的 utilities 打进包里就行。

真正需要注意的只有四条：

1. **别把 preflight 带进来**。Tailwind 的 preflight 会重置 `button`、`input`、`h1` 等基础样式，宿主界面会和它打架。插件只编 utilities（`corePlugins: { preflight: false }`），或者用 `@layer` 隔离。
2. **样式要有独立生命周期**。插入时给样式表打标记，卸载时按标记移除，避免插件卸载后样式继续污染宿主：

   ```js
   const link = document.createElement('link');
   link.rel = 'stylesheet';
   link.dataset.deviceforgePlugin = PLUGIN_ID;
   link.href = new URL('./index.css', import.meta.url).href;
   document.head.append(link);
   return () => link.remove();
   ```

3. **自定义类名加前缀**。宿主的全局类名（`tool-link`、`rail-pane` 等）随时可能变，插件自己定义的类名一律写成 `df-<插件ID>-*`，避免互相覆盖。
4. **主题变量白送**。宿主把主题变量挂在 `:root` 上，插件用 `var(--primary)`、`var(--hairline)` 之类可以直接跟着宿主换主题；写死颜色就会在换主题时突兀。

React 二选一，**不要混用**：同一个插件内既自带又引入宿主的，会得到两份实例，渲染同一棵子树直接报错。

**推荐用宿主实例**（不打包 React，包体最小、主题与组件版本自动跟随）：

```js
import { React, mountReact, Button } from 'deviceforge-host';
```

宿主的 `index.html` 已登记 importmap，把 `deviceforge-host`、`react`、`react/jsx-runtime`、`react/jsx-dev-runtime`、`react-dom`、`react-dom/client` 全部指向 `/plugin-host.js`。这个垫片只从全局契约 `__DEVICEFORGE_HOST_UI__` 取值，自身不带 React，所以四个说明符指向同一份实例是安全的。用自动 JSX 运行时也不需要额外配置——`react/jsx-runtime` 已指向垫片，导出的 `jsx/jsxs/Fragment` 就是宿主的运行时。

纯 ESM 插件因此可以完全不构建：直接写 `import` 与 `React.createElement`（或 `.jsx` 交给自己的构建），`npm pack` 出包即可。用 TypeScript/TSX 的话照常在开发环境构建，构建时**不要**把 `react` 打进 bundle，也不要在产物里内联 React。

**自带 React** 也可以：构建时把 `react`、`react-dom` 打进去，但那时就不要 import `deviceforge-host`（除了纯类型）。两条路都不要访问宿主的内部模块路径——宿主只承诺槽位与 SDK 契约。


## 旧独立浏览器包安装兼容

1. 在当前宿主的插件管理页选择浏览器包类型并上传 ZIP/TGZ。
2. 上传成功表示部署文件已安装；核对返回的插件 ID、版本和入口。
3. 对当前浏览器实例启用插件，等待模块校验与激活成功。
4. 在插件页选择面板或模块进行挂载，验证真实业务。
5. 关闭挂载或停用插件，确认 DOM、订阅、命令和资源收敛。

安装和运行启用是两个动作。服务器包也有自己的安装与启停，不能因浏览器插件成功启用就假设后端能力已就绪。插件 SDK 没有包管理、服务器插件管理或服务令牌字段；这些属于宿主管理界面与 runtime 用例。

同 ID 包不直接覆盖。更新时先停用并删除旧部署，再上传新版，核对版本并重新启用。管理请求的等待取消后应重新查询实际安装和运行状态，不能假设变更回滚或自动重放。删除共享部署也不能强制停止其他同事浏览器中的既有实例。

以上步骤仅用于旧独立组件，不用于统一发布所属组件。完整功能的更新、启停和卸载由统一安装任务协调，要求原始发布修订 `expected_revision`，无需把成套组件拆开删装。

## 资源与局域网

包内模块使用 `./helper.js` 等相对导入；资源以模块 URL 为基准，例如 `new URL('./data.json', import.meta.url)`。实际加载路径包含独立运行段，包内相对依赖随同换代；绝对资源地址或固定跨包导入不会自动继承该生命周期。

局域网 HTTP 页面可能不是安全上下文；使用 `crypto.randomUUID`、剪贴板、文件系统等浏览器 API 前检测支持情况。生成本地运行标记不代表鉴权。默认免鉴权部署和可选令牌部署共用插件包，凭据由宿主处理，不能写入包、提示词、URL、localStorage 或报错输出。

## 网页完整发布与离线安装

成套发布清单使用 `format_version:1,host_api_version:2`，包含实际组件和工具的固定版本、平台、SHA-256、大小、入口键和 bindings。发布前先 GET 目标资源服务器 `/api/v1/capabilities`，确认 `api_version:1`、`release_publication.format_versions` 包含 1、`host_api_versions` 包含 2、`catalog_last` 与 `immutable_versions` 为 true；按返回的 `resource_max_bytes` 检查资源（当前 2 GiB）。缺接口、错误或能力不符均需提示升级并停止上传，不能把资源先写入旧服务器。

仍用现有 HTTP 协议：HEAD `/api/v1/resources/{sha256}` 核对已存在资源的摘要与长度，缺失才 POST `/api/v1/resources`；先全部组件和工具，再上传在线 `release.json`，最后 POST `/api/v1/catalog`。市场只有一个可见 plugin 条目，resource_id 指向清单摘要，details 为 `release_format_version:1,host_api_version:2`。任一资源未准备好不提交目录，同 ID/版本不可覆盖；失败前上传的资源可保留。资源服务返回普通 JSON，与宿主 v2 日志封套不同，不新增服务器 ZIP 解包发布接口。

离线 ZIP 根包含 `release.json` 和它引用的全部资源，例如 `blobs/<sha256>`；网页在本地解析发布闭包，不把 ZIP 作为资源服务解包请求。安装到宿主时先上传 `/api/v2/plugin-installations/artifacts?filename=包名.zip` 获取产物 ID，再用 offline source 提交统一安装；在线 source 使用受信目录内清单 URL、发布 ID、版本和在线清单原始摘要。在线转换 path 后必须重算清单摘要，不混用离线修订。安装、发布均须查询各自实际结果，不把进度界面当成功证据。

用户配置保存在运行宿主用户根的 `plugin-configurations/browser` 和 `server`，工具内容在共享 `tools`，npx 缓存与下载目录不保存业务原值。托管入口自动进入服务器有效配置，高级路径覆盖由部署者显式设置；浏览器不选择服务器绝对路径，也不覆盖用户原值。卸载发布保留配置，是否清理工具继续受共享引用保护。

## 新版共享依赖

新发布优先使用 v2 和统一 dependencies，详见[共享依赖](dependencies.md)。本篇格式 1 的工具全量闭包为旧兼容描述；v2 的 capabilities 和 catalog 标记均使用 2。市场来源只上传其自身固定归档，官方 HTTPS 来源有独立摘要，不强制内嵌全部工具。用户一次安装先发现后端本机环境及整个用户根仓库，只有缺失必需项自动下载；依赖面板负责重试和可选补装。主 npm 包不包含工具归档。
