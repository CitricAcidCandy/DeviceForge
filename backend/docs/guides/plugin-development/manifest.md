# 服务器插件清单

## 推荐：只维护 manifest.json

开发清单统一命名为 `manifest.json`，以 `manifest_version:1` 标识。开发者只维护这一份 DeviceForge 声明；自己的 Cargo.toml、package.json 只负责语言依赖和构建。运行清单、分发用 package.json、market.json、dependencies.json 和最终 release.json 由 `deviceforge plugin pack` 生成，不在源工程重复维护。先自行构建，再打包；工具不执行构建脚本。

以下是前后端配套功能的完整声明结构：

```json
{
  "manifest_version": 1,
  "id": "guide-suite", "version": "1.0.0",
  "name": "指南配套功能", "description": "提供服务器回显和浏览器面板。",
  "market": {
    "summary": "服务器与浏览器配套示例",
    "keywords": ["示例", "回显"], "categories": ["function"],
    "applies_to": ["deviceforge"], "supports_mcp": "server",
    "supports_agent": true, "restart_policy": "none",
    "author": "插件开发者", "license": "MIT", "homepage": "https://example.com",
    "visibility": "market", "details": {}
  },
  "components": [
    {
      "kind": "server", "root": "server", "files": ["entry.mjs"],
      "entrypoints": {"any": {"runtime": "node", "path": "entry.mjs"}},
      "plugin": {"protocol_version": 1, "operations": [
        {"name": "echo", "title": "回显", "input_schema": {"type": "object"}}
      ]}
    },
    {
      "kind": "browser", "root": "web", "files": ["index.js"],
      "entrypoints": {"any": {"runtime": "browser", "path": "index.js"}}
    }
  ]
}
```

顶层必填 manifest_version/id/version/name/description/components。功能 ID 为字母开头、最多99字节的小写字母/数字/`._-`，版本为固定版本，名称最多160个UTF-8字节、描述最多16384字节。组件必填 kind/files/entrypoints，root 默认 `.`，路径相对清单目录；files 显式列出构建后的文件或目录，不使用 glob，不包含自动生成清单。单组件 ID 默认继承功能 ID，多组件默认 `<功能ID>.<kind>`；同类多个组件须显式指定不同 id。组件 version 默认继承顶层，独立版本才覆盖；package_name 可选。plugin 放公开运行字段，禁止重复 id/version/executable。服务器可声明 operations、configuration、artifacts、devices、performance、sessions、recovery、services；普通任务协议为1–4或6，浏览器 SDK 默认为2。

浏览器入口可默认导出对象或 `({id,version,apiVersion}) => 插件对象` 的身份工厂。工具生成包装入口注入身份，工厂可用 `id + '.panel'` 构造贡献 ID，无需在代码复制版本；手写身份与清单冲突时明确报错。原生组件用 native 和实际 win32-x64 等平台，Python等解释器入口用 script 并引用统一依赖的 `{id,entry}`。

共享依赖放顶层 `dependencies:{format_version:1,dependencies:[...]}`；随包本地归档在 dependency_files 按依赖ID填写 `{file,platform,version,format,entries}` 或其数组，file 相对清单目录，摘要和大小自动计算。必需用户输入放顶层 requirements，bindings/requirements 的 component_id 指向最终组件 ID。详细依赖结构查询 dependencies 主题。工具生成组件依赖和完整发布格式2，旧格式1仍可读取。

## 元数据类型对照

下面的“类型”分别描述数据形状与业务类别，不共用同一个枚举。开发清单拒绝未知字段；没有使用的可选能力应省略。

| 声明位置 | 数据类型与用途 | 必填、默认值或合法值 |
| --- | --- | --- |
| manifest_version | 整数，开发清单版本 | 必填，固定 1 |
| id/version/name/description | 字符串，功能身份、固定版本及中文展示内容 | 必填；不在组件或市场资料重复维护 |
| components | 组件对象数组 | 必填，1–32 项 |
| components[].kind | 字符串，组件运行位置 | 必填，仅 server/browser；不是市场分类 |
| components[].id/version | 字符串，最终组件身份与固定版本 | 可选，按前述规则继承；引用组件时使用继承后的最终 ID |
| components[].root | 字符串，组件文件根 | 默认 .，相对清单目录 |
| components[].package_name | 字符串，生成的 npm 包名 | 默认 deviceforge-plugin- 加组件 ID；与插件身份分别使用 |
| components[].files | 字符串数组，已构建文件或目录 | 必填，1–256 项，不用 glob |
| components[].entrypoints | 以平台名为键、入口对象为值的对象 | 必填，1–32 项；浏览器固定 any，原生须实际 os-arch |
| entrypoints.<平台>.runtime/path | 字符串，运行时及相对组件根的入口文件 | 必填；浏览器为 browser，服务器为 native/node/script |
| entrypoints.<平台>.dependency | {id:string,entry:string}，解释器的依赖 ID 与稳定入口键 | script 必填，node 可选，native 不适用；关联必需依赖 |
| components[].plugin | 公开运行能力对象 | 可选，默认 {}；服务器能力见本主题下文，接口通过 sdk 主题查询 |
| market | 市场展示对象 | 可选，默认值与字段类型见下表 |
| dependencies | {format_version:1,dependencies:依赖对象数组} | 可选，默认空依赖；完整结构通过 target:backend/topic:dependencies 查询 |
| dependency_files | 依赖 ID 到本地输入对象或其数组的映射对象 | 可选，默认 {}；每项必填 file/platform/version/format/entries，sha256/size 可选核对 |
| requirements | 用户输入对象数组 | 可选，默认 []，最多128项；字段见本主题“完整功能发布清单” |

市场条目 `kind` 在资源目录通用协议中有 plugin/tool/config/distribution/resource 五种；本插件开发清单生成的条目固定为 plugin，不在 market 中填写 kind。function/theme/ui/integration 是 `market.categories` 的分类标签：分别表示功能、主题、界面、集成，可多选；主题和界面插件的组件通常仍是 browser，不能把 theme/ui 当 components[].kind 或 runtime。`supports_mcp` 只描述客户端、服务器端或双向 MCP 能力，不会因填写 server 自动为插件创建新的监听服务。

本地输入 `format` 取 zip/tgz/file，`entries` 为稳定入口键到归档内相对路径的字符串映射，file 格式固定映射到 payload。版本和平台为字符串，size 为正整数字节数，sha256 为64位小写十六进制字符串；未提供摘要与大小时由工具根据实际文件计算。JSON 对象中的布尔字段使用 true/false，数组不能写成逗号分隔字符串。

## market 数据结构与默认值

market 是可选对象，下面是全部可声明字段。id/version/name/description/kind/metadata_version/resource_id/platforms/architectures 不在这里重复声明：身份和展示名来自顶层，类型固定 plugin，资源摘要由发布工具计算，平台由入口生成。未知字段、重复身份、非法枚举或重复数组项都会报错。

| 字段 | 类型、默认值与约束 |
| --- | --- |
| summary | 字符串，最多400个UTF-8字节；省略则从 description 取不超过400字节的单行简介 |
| keywords | 字符串数组，默认 []，最多64项；每项最多100字节、非空且不重复 |
| categories | 字符串数组，默认 ["function"]，最多16项；仅 function/theme/ui/integration |
| applies_to | 非空字符串数组，默认 ["deviceforge"]，最多64项；每项最多100字节 |
| supports_mcp | none/client/server/both，默认 none；描述实际能力，不自动推断 |
| supports_agent | 布尔值，默认 false，不接受字符串 "true" |
| restart_policy | none/browser_refresh/plugin_reload/service_restart/device_restart，默认 none |
| author、license | 可选非空字符串，各最多200字节 |
| homepage | 可选无凭据 HTTP/HTTPS URL，最多2048字节 |
| visibility | market/internal，默认 market |
| details | JSON 对象，默认 {}；组件 plugin_kind 和发布 release_format_version/host_api_version 由工具写入 |

生成市场资料为 `{metadata_version:1,id,version,kind:"plugin",name,summary,description,keywords,categories,applies_to,supports_mcp,supports_agent,restart_policy,platforms,architectures,visibility,details}`，另保留可选 author/license/homepage。catalog 发布时才增加 resource_id，值为在线 release.json 的实际 SHA-256，不能预写进归档形成循环摘要。旧组件缺少 market.json 仍可本地安装；新流程自动生成完整资料，发布时无需另写文件。

## 生成产物与旧包格式（兼容参考）

以下描述自动生成的运行与发布文件，用于理解旧包和排错，不要求手工维护第二套声明。开发清单与安装后的运行 manifest.json 属于不同目录和阶段，不可互换。

服务器插件有两种清单形态：便携包中的 `plugin.json` 省略机器入口路径；部署目录中的 `manifest.json` 由安装器填入绝对 `executable`。普通任务声明协议 1–4，反向服务任务显式选择 6；独立会话仍为 5。不要在便携包写入开发机路径。

## 最小便携清单

```json
{
  "id": "guide_echo",
  "version": "1.0.0",
  "protocol_version": 1,
  "args": [],
  "operations": [{
    "name": "echo",
    "title": "指南示例回显",
    "input_schema": {
      "type": "object",
      "properties": {"message": {"type": "string", "maxLength": 1000}},
      "required": ["message"],
      "additionalProperties": false
    }
  }]
}
```

`id` 使用小写字母、数字和 `._-`，以字母或数字开头，最多 99 字节；不能使用宿主保留的 `builtin.` 前缀。操作公开为 `plugin.guide_echo.echo`，完整名称必须符合 MCP 名称规则且不超过 128 字符。`deviceforge.*` 是宿主保留空间。版本与 `package.json.version` 一致。

`input_schema` 必须为对象模式；注册时编译，执行前校验。不要使用外部 `$ref` 或 `$id`。同包重复操作、无效模式、协议不兼容会使注册失败。清单和能力模型拒绝未知字段。

## 按需增加的声明

- `operations[].execution`：普通操作的版本化总预算；实际字段与范围以当前公开 `ExecutionBudget` 为准，省略时由宿主确定默认值，业务请求不能自行覆盖。
- `artifacts`：协议 2–4 的 `input_fields`、`input_pointers` 和 `outputs`。只允许声明的产物 ID 引用，不接收任意本机路径；嵌套设备输入可使用 `/input/artifact_id`。
- `devices`：公开设备发现与版本化能力，声明能力范围及读写访问；新增平台经此契约接入，不能通过修改通用路由添加平台分支。
- `performance`：公开采样来源。API 2 需协议 4，并绑定同插件设备 API 3 的精确只读能力；不应从平台名猜测能力。
- `sessions`：独立协议 5 的会话贡献与输入/输出限额，顶层任务协议为 1–4 或显式选择 6。需要宿主提供客户端身份时显式声明 `client_context=true`；不能从业务输入自行认定客户端为本机。

这些声明并非可互换的通用对象。实现设备、性能或会话插件前，应核对公开 SDK 中对应模块和契约，保持原始整数、可空字段和身份规则。最小回显示例无需这些可选能力。

## 完整功能发布清单

`release.json` 是外层发布清单，不替代服务器 `plugin.json`。格式为 `format_version:2`、`host_api_version:2`，含 `id/version/name/description/components/tools/requirements`。`components[]` 含 `id/kind/version/variants`，其中 `kind` 取 `"server"` 或 `"browser"`；每个变体为 `platform/path/sha256/size/format`，组件格式仍为独立 ZIP/TGZ。成品版本必须锁定为实际固定版本，摘要和大小按最终原始字节计算。

`tools[]` 含固定 `id/version`、`required`（缺省 true）、变体和 `bindings`。工具格式可为 ZIP/TGZ/file，变体 `entries` 将稳定资源键映射到归档内文件；file 固定映射到 `payload`。绑定 `{component_id,config_pointer,entry}` 把资源键连接到组件有效配置，不能用开发机路径替代。可选工具缺当前平台可略过，但已选择资源的下载或完整性失败仍失败。

`requirements[]` 为 `{component_id,config_pointer,any_of?,title,description,sensitive?,required?}`；同一声明的主 JSON Pointer 或最多 16 个候选 `any_of` 任一原值填写即可，多条必填仍全部满足。未知或重复指针、非法转义及无组件归属会被拒绝。二选一、值类型等完整约束仍归组件配置 schema；敏感字段不能根据遮蔽字符串判断是否已配置。

组件的 `configuration` 声明版本、schema、defaults 和 apply_policy；为字段提供中文 `title/description`，敏感值使用公开敏感声明，不能用示例项目/令牌填充真实必要输入。发布和市场外显名、描述使用 `release.json.name/description` 与 `market.json`；插件 ID 保持稳定机器身份。安装器不改用户配置原值，托管路径只写有效快照。

### 配置声明的完整字段

在 `components[].plugin.configuration` 声明一次，打包器写入生成的组件清单；浏览器配套组件还会把相同配置带入生成入口，无需重复维护。

| 字段 | 类型、必填与默认 | 约束及语义 |
| --- | --- | --- |
| version | 整数，必填 | 1–4294967295，配置结构版本；不是插件版本字符串 |
| schema | JSON Schema 对象，必填 | 根 type 固定 object；通过 properties、required、additionalProperties 和本地引用约束字段 |
| defaults | JSON 对象，必填 | 初始配置草稿，可缺少 required 用户输入；已提供的值仍须符合字段约束，不用示例凭据冒充用户输入 |
| apply_policy | 字符串，可省略 | 打包器和宿主均默认 next_invocation，也可显式 plugin_reload；分别为下次调用或插件重载生效，未知值仍拒绝 |
| legacy_filename | 字符串或 null，可选 | 旧服务器配置迁移文件名，不含路径、非空且最多180个UTF-8字节；新工程通常省略 |

安装和配置就绪分开：可先安装缺少必填输入的插件，配置视图显示待填写字段，保存、应用及运行时继续校验完整 schema。发布 requirements 可进一步把相关输入表达为完整功能的启用门禁。下面为开发清单片段，其余身份、入口和 files 沿用完整示例；component_id 对应最终组件 ID：

```json
{
  "components": [{
    "id": "example_server",
    "plugin": { "configuration": {
      "version": 1,
      "apply_policy": "next_invocation",
      "schema": {
        "type": "object",
        "properties": { "configUrl": {
          "type": "string", "title": "配置地址", "pattern": "^https?://", "minLength": 1
        } },
        "required": ["configUrl"], "additionalProperties": false
      },
      "defaults": {}
    } }
  }],
  "requirements": [{
    "component_id": "example_server", "config_pointer": "/configUrl",
    "title": "配置地址", "description": "启用前填写实际 HTTP/HTTPS 配置地址", "required": true
  }]
}
```

schema.required 含 configUrl 而 defaults:{} 时仍可安装，缺失输入由配置状态说明，不能直接运行；填写实际值并通过完整模式验证后再启用。只有缺失必填字段的错误可作为草稿保留，已提供的错误类型、越界值或无效模式仍会拒绝。打包器提前校验声明结构与生效策略，完整模式编译仍由宿主负责。旧完整离线ZIP省略apply_policy同样按next_invocation读取，不改包内容、摘要或业务代码，无需为此重打包。


新版统一依赖使用 dependencies.json（独立组件）或 v2 清单的 dependencies，先自动发现本机与用户根共享工具，一次安装只下载缺失必需项；启动与重新检测不下载。v1 保留兼容。完整字段、来源约束与管理接口通过本指南工具查询 `dependencies` 主题。

## 公共服务声明

可选 services={provided,required}：provided 的 service={id,version} 使用非空字符串精确版本，contract 包含 input_schema/output_schema，operation 仅映射已有普通操作；required 用 operations/sessions 短名限定相关入口，不因依赖缺失停止整个插件。普通任务显式选择 protocol_version=6 才启用反向服务帧，便携安装原样保留声明。公共运行入口及取消、期限和清理约束分别查询本指南的 `sdk` 与 `lifecycle` 主题。

旧 JSON 清单可省略 `services`，普通任务协议 1–4 和独立会话协议 5 不强制迁移。使用新版 Rust SDK 重新编译、且以结构体字面量手写 `Manifest { ... }` 时，需补 `services: None` 或实际服务声明；这是源码构造的适配点，不要求重写已安装清单或升级旧二进制。
