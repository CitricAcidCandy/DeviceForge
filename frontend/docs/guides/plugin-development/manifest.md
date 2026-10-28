# 浏览器插件清单

## 推荐：只维护 manifest.json

开发者只维护 `manifest.json`，以 `manifest_version:1` 标识。`deviceforge plugin pack` 自动生成分发 package.json、plugin.json、market.json、dependencies.json、组件 TGZ 和完整 release.json；这些文件不需要在源工程重复编辑。自己的 package.json 只负责语言依赖和构建。以下是一个可配合独立 ESM 入口打包的完整声明：

```json
{
  "manifest_version": 1,
  "id": "browser-guide", "version": "1.0.0",
  "name": "浏览器示例", "description": "通过公开接口扩展工作台。",
  "market": {
    "summary": "工作台扩展示例", "keywords": ["示例"], "categories": ["ui"],
    "applies_to": ["deviceforge"], "supports_mcp": "none", "supports_agent": false,
    "restart_policy": "none", "author": "插件开发者", "license": "MIT",
    "homepage": "https://example.com", "visibility": "market", "details": {}
  },
  "components": [{
    "kind": "browser", "files": ["index.js"],
    "entrypoints": {"any": {"runtime": "browser", "path": "index.js"}}
  }]
}
```

顶层必填 manifest_version/id/version/name/description/components。ID 为字母开头、最多99字节的小写字母/数字/`._-`，版本为固定版本，名称最多160个UTF-8字节，描述最多16384字节。组件必填 kind/files/entrypoints，root 默认 `.`，路径相对清单目录。files 显式列出已构建文件或目录，不用 glob，不包含生成清单。单组件 id 继承功能ID，多组件默认 `<功能ID>.<kind>`；同类多个组件须显式给不同 id。version 默认继承顶层，只有独立版本才覆盖，package_name 可选。plugin 可声明 api_version（默认2）与 configuration，不能再放 id/version/executable。

浏览器 ESM 可以默认导出对象或 `({id,version,apiVersion}) => 插件对象` 的身份工厂。工具生成包装入口注入身份；贡献用 `id + '.panel'` 构造命名空间，不必在代码重复版本。手写身份与清单冲突时明确报错。配套服务器作为另一个 kind:server 组件放在同一 components 中。共享依赖在顶层 dependencies，用户输入在 requirements；需要本地归档时 dependency_files 按依赖ID填写 `{file,platform,version,format,entries}` 或其数组，摘要和大小自动计算；bindings/requirements 的 component_id 指向最终组件 ID。服务器完整字段查询 target:backend/topic:manifest，依赖结构查询 dependencies 主题。

## 元数据类型对照

字段的数据形状、组件运行位置和市场分类各自独立，不能混填。未使用的可选能力应省略，清单拒绝未知字段。

| 声明位置 | 数据类型与用途 | 必填、默认值或合法值 |
| --- | --- | --- |
| manifest_version | 整数，开发清单版本 | 必填，固定 1 |
| id/version/name/description | 字符串，功能身份、固定版本及中文展示内容 | 必填；组件和市场资料从顶层继承 |
| components | 组件对象数组 | 必填，1–32 项 |
| components[].kind | 字符串，组件运行位置 | 必填，仅 browser/server |
| components[].id/version | 字符串，最终组件身份与固定版本 | 可选，按前述规则继承；贡献命名空间使用最终组件 ID |
| components[].root | 字符串，组件文件根 | 默认 .，相对清单目录 |
| components[].package_name | 字符串，生成的 npm 包名 | 默认 deviceforge-plugin- 加组件 ID |
| components[].files | 字符串数组，已构建文件或目录 | 必填，1–256 项，不用 glob |
| components[].entrypoints | 以平台名为键、入口对象为值的对象 | 必填，1–32 项；浏览器固定 any |
| entrypoints.any.runtime/path | 字符串，运行时与相对组件根的入口 | 浏览器固定 runtime:browser，path 指向已构建 ESM |
| components[].plugin.api_version | 整数，浏览器 SDK 版本 | 可选，默认且仅支持 2 |
| components[].plugin.configuration | 配置对象，含版本、schema、defaults、apply_policy | 可选，通过公开配置能力消费；不放到 market.details 代替运行声明 |
| market | 市场展示对象 | 可选，默认值与字段类型见下表 |
| dependencies | {format_version:1,dependencies:依赖对象数组} | 可选，默认空依赖；完整结构通过 target:backend/topic:dependencies 查询 |
| dependency_files | 依赖 ID 到本地输入对象或其数组的映射对象 | 可选，默认 {}；每项必填 file/platform/version/format/entries，sha256/size 可选核对 |
| requirements | 用户输入对象数组 | 可选，默认 []，最多128项；字段见本主题“成套发布与基础配置” |

通用市场条目 `kind` 有 plugin/tool/config/distribution/resource 五种；本插件开发清单自动生成 kind:plugin，不能在 market 中重复填写。`market.categories` 的 function/theme/ui/integration 分别是功能、主题、界面、集成，可多选；主题插件也应声明 components[].kind:browser，不能用 theme 作为组件种类或运行时。配套服务器的运行时才使用 native/node/script；完整入口与运行能力通过 target:backend/topic:manifest 查询。

本地依赖输入的 file/platform/version 为字符串，format 为 zip/tgz/file，entries 为稳定入口键到归档内相对路径的字符串映射；file 格式固定映射到 payload。sha256 是64位小写十六进制字符串，size 为正整数字节数，省略时由工具计算。布尔字段使用 true/false，字符串数组使用 JSON 数组，details 必须是 JSON 对象。

## market 数据结构与默认值

market 是可选对象，支持以下全部字段。id/version/name/description/kind/metadata_version/resource_id/platforms/architectures 不重复填写：身份、展示名与描述取顶层，kind 固定 plugin，平台从入口生成，资源摘要由发布工具计算。未知字段、重复身份、非法枚举或重复数组项会报错。

| 字段 | 类型、默认值与约束 |
| --- | --- |
| summary | 字符串，最多400个UTF-8字节；省略则从 description 取不超过400字节的单行简介 |
| keywords | 字符串数组，默认 []，最多64项；每项最多100字节、非空且不重复 |
| categories | 字符串数组，默认 ["function"]，最多16项；仅 function/theme/ui/integration |
| applies_to | 非空字符串数组，默认 ["deviceforge"]，最多64项；每项最多100字节 |
| supports_mcp | none/client/server/both，默认 none，不自动推断 |
| supports_agent | 布尔值，默认 false，不接受字符串 "true" |
| restart_policy | none/browser_refresh/plugin_reload/service_restart/device_restart，默认 none |
| author、license | 可选非空字符串，各最多200字节 |
| homepage | 可选无凭据 HTTP/HTTPS URL，最多2048字节 |
| visibility | market/internal，默认 market |
| details | JSON 对象，默认 {}；组件 plugin_kind 和发布 release_format_version/host_api_version 由工具写入 |

生成的市场资料是 `{metadata_version:1,id,version,kind:"plugin",name,summary,description,keywords,categories,applies_to,supports_mcp,supports_agent,restart_policy,platforms,architectures,visibility,details}`，另保留可选 author/license/homepage。catalog 发布时才增加 resource_id，值为在线 release.json 的实际 SHA-256，不能预写进归档形成循环摘要。market.json 是自动生成的发布资料，不是第四份手写声明；旧包缺少它仍可本地安装。

## 生成产物与旧包格式（兼容参考）

以下描述自动生成的文件，用于理解旧包和排错，不要求手工维护第二套声明。

浏览器包需要 `package.json`、由其引用的 `plugin.json` 以及已构建的 ESM 入口。三处插件版本应保持一致；插件清单 `api_version` 与入口对象 `apiVersion` 均为 2。`package.json.name` 是 npm 包名，可以不同于插件 ID；身份以 `plugin.json.id` 和入口默认导出对象的 `id` 为准，两者必须相同。

## package.json

```json
{
  "name": "deviceforge-browser-guide-example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "files": ["plugin.json", "src"],
  "deviceforge": {
    "kind": "browser",
    "manifest": "plugin.json",
    "entrypoints": {
      "any": { "runtime": "browser", "path": "src/index.js" }
    }
  }
}
```

`deviceforge.kind` 固定为 `browser`。浏览器入口采用 `entrypoints.any`，其 `runtime` 固定为 `browser`，`path` 指向包内存在的 JavaScript 模块。不要把 TypeScript、TSX、CommonJS 或仅存在于开发机的文件声明为可直接执行入口。`type: module` 也使 Node 语法检查和本地导入按 ESM 解释 `.js`。

`manifest` 和 `path` 均相对包根；使用 `/` 分隔的相对路径，不使用盘符、绝对路径、`..`、网络 URL 或指向包外的链接。npm TGZ 的标准外层 `package/` 由解包器识别；不要把 `package/` 写进入口路径。文件是否进入归档由实际打包结果确认，`files` 只是 npm 的打包配置。

## plugin.json

```json
{
  "id": "browser_guide_example",
  "version": "0.1.0",
  "api_version": 2
}
```

插件 ID 使用 `^[a-z][a-z0-9._-]{0,99}$`。入口导出 `id/version/apiVersion/panels`；即使没有面板，`panels` 也要提供空数组。`activate`、`deactivate`、`contributions` 可省略。版本须为非空字符串，建议保持语义版本，并与包和清单一致。

## 贡献标识与可选字段

面板、组件、模块、命令、服务、钩子和主题 ID 必须以 `<插件ID>.` 开头，并匹配 `^[a-z][a-z0-9._-]{0,199}$`。贡献 ID 不得重复；模块路由按插件命名空间判重，不同插件可各自使用 `/catalog`。同一插件的 `/a/b` 与 `/a-b` 会归一成相同页面键，必须避免此类碰撞。标题必须非空。模块 `route` 必须以 `/` 开头，不能以 `//` 开头，不能包含 `?`、`#` 或反斜线。

可选字段应按需省略：`components.mode` 缺省为 `append`，支持 `replace`；`beforeTaskSubmit.priority` 是可选安全整数；服务 `version` 为非空精确匹配字符串，不代表宿主支持 semver 范围；主题可选 `variables/css/colorScheme`。不要为未知字段凭空创造权限、依赖安装或后台能力声明。

SDK 2 的 `extensions/devices/artifacts/taskHistory/themes` 是可选上下文字段；不能通过清单强制让旧宿主获得这些能力。运行时先检查所需字段，再查询实际服务或设备能力。

## 成套发布与基础配置

浏览器 `plugin.json` 保持 `api_version:2`；外层 `release.json` 使用 `format_version:2`、`host_api_version:2`，以 `components[]` 组合独立服务器和浏览器包。每项是 `{id,kind,version,variants:[{platform,path,sha256,size,format}]}`，其中 kind 为 `server` 或 `browser`。组件版本和归档身份对应，不混用服务器程序入口与浏览器 ESM 入口。

工具在外层 `tools` 声明固定版本、平台变体、稳定 `entries` 及 `bindings:[{component_id,config_pointer,entry}]`，由宿主准备，不由浏览器下载到本地服务器目录。必要用户输入在 `requirements` 声明 `component_id/config_pointer/title/description/required/sensitive`，可用 `any_of` 提供同组件最多 16 个去重候选；组内任一原值满足，多个必填组分别满足。相互排斥继续由配置 schema 验证。

外显功能名称和描述来自发布 `name/description` 与市场元数据，组件 ID 用于稳定引用。公开 `configuration` 提供版本、schema、defaults、apply_policy，字段用中文 title/description；敏感字段不能因显示 `********` 就认定已填写。不要把开发机工具绝对路径、凭据或用户业务配置固化到包中。服务器托管路径只进入有效配置，不写浏览器配置原值；高级覆盖由宿主管理配置流程处理。


新版统一依赖使用 dependencies.json（独立组件）或 v2 清单的 dependencies，先自动发现本机与用户根共享工具，一次安装只下载缺失必需项；启动与重新检测不下载。v1 保留兼容。完整字段、来源约束与管理接口通过本指南工具查询 `dependencies` 主题。
