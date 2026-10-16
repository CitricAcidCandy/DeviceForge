# 服务器插件清单

服务器插件有两种清单形态：便携包中的 `plugin.json` 省略机器入口路径；部署目录中的 `manifest.json` 由安装器填入绝对 `executable`。它们均声明普通任务协议 1–4。不要在便携包写入开发机路径。

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
