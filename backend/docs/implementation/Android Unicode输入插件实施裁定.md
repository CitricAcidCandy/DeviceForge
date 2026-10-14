# Android Unicode 输入插件实施裁定

## 目标与边界

Android 设备插件继续使用 `input` 能力版本 1 和 `input` 操作。现有可打印 ASCII 文本保持原有 `adb shell input text` 分片行为；包含非 ASCII 字符的同一 `text` 动作使用部署者明确配置的 ADB Keyboard 广播。此能力只说明 ADB 工具接受广播，不证明真机界面已经插入文字。

本批不自动安装键盘、不切换或恢复用户输入法、不接收请求提供的程序、包名、组件、广播动作或额外 shell 字符串，也不把 Unicode 文本静默降级为 ASCII。

## 公开契约

请求仍为：

```json
{
  "device_id": "设备标识",
  "input": {
    "action": {"kind": "text", "text": "文本", "enter": false}
  }
}
```

`device_id`、能力 ID、版本和操作名均不变。ASCII 文本限 1 至 1024 个 UTF-8 字节，且每个字节为可打印 ASCII；Unicode 文本限 1 至 4096 个 UTF-8 字节，拒绝控制字符。`enter` 仍只表示成功广播后是否追加原有回车 keyevent。

Unicode 成功结果固定为：

```json
{
  "device_id": "设备标识",
  "action": "text",
  "transport": "adb_keyboard_base64",
  "bytes": 6,
  "dispatched": true
}
```

`bytes` 是原始 UTF-8 字节数。该结果不回传文本、Base64 或设备输出。

## 部署配置与固定目标

配置增加可选 `unicode_input` 对象。启用 Unicode 输入时必须显式提供以下固定值：

| 字段 | 固定值 |
| --- | --- |
| `package` | `com.android.adbkeyboard` |
| `component` | `com.android.adbkeyboard/.AdbIME` |
| `action` | `ADB_INPUT_TEXT` |
| `extra` | `msg` |

配置值只能逐项等于固定值，不能借此更换目标。未配置时 ASCII 仍可用；Unicode 请求返回依赖未准备错误。

执行 Unicode 请求前，在同一 InvocationContext 取消信号和原绝对截止点下按顺序核验：

1. `pm path com.android.adbkeyboard` 返回已安装包路径；
2. `ime list -s` 含 `com.android.adbkeyboard/.AdbIME`，表示输入法已启用；
3. `settings get secure default_input_method` 精确等于该组件，表示当前输入法已选中。

三项任一失败都不切换输入法，返回依赖失败。

`pm path` 的成功输出按 ADB 的实际格式判断：至少一行以 `package:` 开头且其后路径非空，例如
`package:/data/app/.../base.apk`。不能把包名直接拼接在 `package:` 后做前缀匹配，否则会误拒绝真实安装路径。

## 分层职责

| 模块 | 负责 | 不负责 | 副作用 |
| --- | --- | --- | --- |
| `rules/unicode.rs` | UTF-8 字节和控制字符校验、Base64 编码、固定广播参数 | 读取配置、执行 ADB、解释设备输出 | 无 |
| `config.rs` | 读取并校验 `unicode_input` 固定配置 | 接收请求覆盖、探测设备、安装或切换输入法 | 有界文件读取 |
| `session/unicode.rs` | 依次核验安装/启用/当前状态并广播，沿原取消和截止点 | 解析业务 JSON、生成公开错误、恢复输入法 | 通过既有 `Control` 执行固定 argv |
| `operations` | 解析 `text` 动作并选择 ASCII 或 Unicode 流程 | 拼接 shell 字符串、决定部署入口 | 无；调用会话层 |
| `manifest.json` | 声明既有 `input` 能力和字段形状 | 声明部署凭据或动态目标 | 无 |

ADB Keyboard 广播 argv 固定为：

```text
-s <device_id> shell -T am broadcast -a ADB_INPUT_TEXT --es msg <base64>
```

不经过 shell 字符串。`enter` 为真时追加现有 `keyevent 66`，仍受同一截止点和取消检查约束。

## 错误、清理与日志

- 字段、UTF-8 字节数、控制字符或固定配置不合法：`invalid_input`。
- 未配置、未安装、未启用、当前输入法不匹配、ADB 或广播失败：`dependency_failed`。
- 取消、期限到期和资源未确认分别沿公共 `cancelled`、`timeout`、`cleanup_failed` 语义返回。
- 插件错误不含原文本、Base64、设备输出、配置路径或凭据；宿主通过既有 `log_id` 关联请求、任务和插件调用。

## 验证范围

源代码回归至少覆盖 Unicode 字节边界、控制字符、Base64、固定广播 argv、配置目标拒绝和 ASCII 路径不变。真实输入法安装、启用、当前选择及真机文字效果仍由独立服务和真机验收；源码、模拟 ADB 或工具接收成功不能代替该证据。

本批新增的假 ADB 回归只证明五段固定 argv、真实 `pm path` 输出形状、广播 Base64、回车追加及公开结果字段；不证明设备已安装或启用 ADB Keyboard，也不证明目标应用完成文字插入。
