# 类型化组合服务示例

独立于 `server-service-normalize` 构建与部署，只依赖公开 SDK、运行库和 Rust 通用库。`ServiceHandle<Text, Text>` 经协议 6 的 `service_call/result/cancel` 回到宿主，禁止通过 HTTP 直连另一个插件。

- 提供 `example.text.compose@"1.0"`，映射已有 `compose` 操作。
- `compose` 必需 `example.text.normalize@"1.0"`；版本逐字符串精确匹配，不把 `"1"` 转成 `"1.0"`。
- `ping` 不依赖规范化服务。提供者未安装、卸载或依赖递归时，仅组合入口拒绝，插件与无关入口保持运行。
- 输入 `{"text":"  HeLLo  "}`，预期业务输出 `{"text":"FORGE: hello"}`。顶层 Job 仍保留宿主产物封套；反向句柄收到契约业务结果。
- 子调用继承根任务取消、绝对截止点和日志上下文，绑定本次目标代际。请求相同祖先操作、祖先已持独占锁或根调用并发额度耗尽均明确失败。

主代理统一执行，当前未构建或运行：

```powershell
cargo build --release --manifest-path examples/server-service-compose/Cargo.toml
New-Item -ItemType Directory -Force examples/server-service-compose/bin
Copy-Item -LiteralPath examples/server-service-compose/target/release/deviceforge-service-compose.exe -Destination examples/server-service-compose/bin/
npm pack ./examples/server-service-compose
```

通过既有统一安装入口分别安装、加载两个包，再调用 `POST /api/v2/services/example.text.compose/calls`，请求 `{"version":"1.0","input":{"text":"  HeLLo  "}}`。应返回现有 202 Job，通过原任务接口等待成功；MCP 的 `deviceforge.call_service` 加 `id` 字段，复用同一用例。

必要负向验证：仅加载本插件仍可执行 `plugin.service-compose.ping`；组合入口拒绝且不创建假成功 Job。加载规范化插件后组合成功；卸载再重载规范化插件后旧 `generation` 请求拒绝，新目录代际请求成功。取消根 Job 后子调用不得晚到覆盖终态。当前未以源码示例冒充真实部署通过。
