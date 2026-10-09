# 独立 Node 设备提供者示例

此目录是自包含、无 npm 依赖、无安装脚本的便携服务器插件，按公开 devices 契约提供发现、提供者信息与设备回显。平台标记 synthetic_demo，所有设备均为模拟，不能作为 Android/Harmony/iOS 或真机支持证据。

在 DeviceForge 根目录使用当前设备契约版本的 CLI：

```powershell
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge plugin install .\backend\examples\device-provider-node
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge start
```

启动会加载已部署插件。服务运行中安装后，通过 HTTP POST /api/v2/plugins/device_node_example/load 或 MCP deviceforge.load_plugin 显式加载。默认免鉴权，非空 APK_API_TOKEN 可选。相同 ID 不覆盖，安装与运行加载是独立操作。

GET /api/v2/device-providers 取得提供者和 generation；POST /api/v2/device-providers/device_node_example/refresh，JSON 输入为 generation，取得宿主设备引用与观测时间。调用 POST /api/v2/device-actions，提供 provider_id、generation、device_id、capability、version 与 input 对象，返回共享任务：provider.describe 需要 device_id=null；device.echo 需要发现返回的本地设备 ID。

设备引用不能只传显示名称或平台字符串。插件只返回本地 ID 和实际能力可用状态，宿主增加提供者身份及加载代际；卸载/重载会使旧引用失效。每次操作启动一个 Node 进程，不保留跨请求内存，不创建持久连接；本示例协议 1 不声明外部资源合作清理。

请求最多 64 KiB，标准输出仅发一个公开响应帧。无需复制宿主内部源码，其他平台插件可替换发现与能力执行逻辑，保留声明/输入/错误/取消边界。需要外部资源清理时改用协议 3 与公开异步运行库，常驻会话须遵守另行制定的传输协议。

当前设备服务正在实施，本示例的宿主安装/调用证据以根 todo.md 后续验收记录为准，不能使用不支持 devices 的旧运行包验收。
