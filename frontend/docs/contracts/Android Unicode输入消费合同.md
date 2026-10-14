# Android Unicode 输入消费合同

前端只消费公开设备 SDK 的 `input` v1 能力，不实现 Android 工具调用。调用身份来自 `DeviceRef(providerId, generation, localId)`，能力版本必须为 `input@1`，设备必须在线且该能力可用；平台名称、设备型号和部署配置不参与前端分支。

请求输入为 `{ action: { kind: "text", text, enter? } }`。`text` 为非空合法 Unicode 且拒绝控制字符；纯可打印 ASCII 的 UTF-8 字节数为 1–1024，含非 ASCII 时为 1–4096。`enter` 是可选布尔值，省略时保持省略并由提供者按 false 处理。前端不增加包名、组件名、命令、编码或配置字段。

提供者自行选择可打印 ASCII 的 shell 输入或 Unicode 的 `adb_keyboard_base64`，后者使用部署者已配置的 `com.android.adbkeyboard/.AdbIME` 与 `ADB_INPUT_TEXT`。前端只解码公开结果：ASCII 为 `device_id/action/dispatched`；Unicode 另有 `transport=adb_keyboard_base64` 与准确 UTF-8 `bytes`。成功表示工具接受请求，不等于目标应用已出现文字。

宿主 `log_id` 由 `HostResult` 传递。取消、设备选择变化、提供者代次变化和销毁沿 `DeviceAccess` 的作用域取消与晚到隔离；前端不自动重试、不自动取消服务器 Job、不保存输入文本。真实 Android、ADB Keyboard、目标应用和视觉 UI 继续独立验收。
