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


新版统一依赖使用 dependencies.json（独立组件）或 v2 清单的 dependencies，先自动发现本机与用户根共享工具，一次安装只下载缺失必需项；启动与重新检测不下载。v1 保留兼容。完整字段、来源约束与管理接口通过本指南工具查询 `dependencies` 主题。

## 公共服务声明

可选 services={provided,required}：provided 的 service={id,version} 使用非空字符串精确版本，contract 包含 input_schema/output_schema，operation 仅映射已有普通操作；required 用 operations/sessions 短名限定相关入口，不因依赖缺失停止整个插件。普通任务显式选择 protocol_version=6 才启用反向服务帧，便携安装原样保留声明。公共运行入口及取消、期限和清理约束分别查询本指南的 `sdk` 与 `lifecycle` 主题。

旧 JSON 清单可省略 `services`，普通任务协议 1–4 和独立会话协议 5 不强制迁移。使用新版 Rust SDK 重新编译、且以结构体字面量手写 `Manifest { ... }` 时，需补 `services: None` 或实际服务声明；这是源码构造的适配点，不要求重写已安装清单或升级旧二进制。
