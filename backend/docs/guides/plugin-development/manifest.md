# 服务器插件清单

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
- `sessions`：独立协议 5 的会话贡献与输入/输出限额，顶层任务协议保持 1–4。需要宿主提供客户端身份时显式声明 `client_context=true`；不能从业务输入自行认定客户端为本机。

这些声明并非可互换的通用对象。实现设备、性能或会话插件前，应核对公开 SDK 中对应模块和契约，保持原始整数、可空字段和身份规则。最小回显示例无需这些可选能力。

## 完整功能发布清单

`release.json` 是外层发布清单，不替代服务器 `plugin.json`。格式为 `format_version:2`、`host_api_version:2`，含 `id/version/name/description/components/tools/requirements`。`components[]` 含 `id/kind/version/variants`，其中 `kind` 取 `"server"` 或 `"browser"`；每个变体为 `platform/path/sha256/size/format`，组件格式仍为独立 ZIP/TGZ。成品版本必须锁定为实际固定版本，摘要和大小按最终原始字节计算。

`tools[]` 含固定 `id/version`、`required`（缺省 true）、变体和 `bindings`。工具格式可为 ZIP/TGZ/file，变体 `entries` 将稳定资源键映射到归档内文件；file 固定映射到 `payload`。绑定 `{component_id,config_pointer,entry}` 把资源键连接到组件有效配置，不能用开发机路径替代。可选工具缺当前平台可略过，但已选择资源的下载或完整性失败仍失败。

`requirements[]` 为 `{component_id,config_pointer,any_of?,title,description,sensitive?,required?}`；同一声明的主 JSON Pointer 或最多 16 个候选 `any_of` 任一原值填写即可，多条必填仍全部满足。未知或重复指针、非法转义及无组件归属会被拒绝。二选一、值类型等完整约束仍归组件配置 schema；敏感字段不能根据遮蔽字符串判断是否已配置。

组件的 `configuration` 声明版本、schema、defaults 和 apply_policy；为字段提供中文 `title/description`，敏感值使用公开敏感声明，不能用示例项目/令牌填充真实必要输入。发布和市场外显名、描述使用 `release.json.name/description` 与 `market.json`；插件 ID 保持稳定机器身份。安装器不改用户配置原值，托管路径只写有效快照。


新版统一依赖使用 dependencies.json（独立组件）或 v2 清单的 dependencies，先自动发现本机与用户根共享工具，一次安装只下载缺失必需项；启动与重新检测不下载。v1 保留兼容。完整字段、来源约束与管理接口见 [共享依赖](dependencies.md)。

## 公共服务声明

可选 services={provided,required}：provided 的 service={id,version} 使用非空字符串精确版本，contract 包含 input_schema/output_schema，operation 仅映射已有普通操作；required 用 operations/sessions 短名限定相关入口，不因依赖缺失停止整个插件。普通任务显式选择 protocol_version=6 才启用反向服务帧，便携安装原样保留声明。完整约束见 ../../contracts/公共服务与协议第六版.md。
