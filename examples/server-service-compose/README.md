# 类型化组合服务示例

独立于 `server-service-normalize` 构建与部署，只依赖公开 SDK、运行库和 Rust 通用库。`ServiceHandle<Text, Text>` 经协议 6 的 `service_call/result/cancel` 回到宿主，禁止通过 HTTP 直连另一个插件。

- 提供 `example.text.compose@"1.0"`，映射已有 `compose` 操作。
- `compose` 必需 `example.text.normalize@"1.0"`；版本逐字符串精确匹配，不把 `"1"` 转成 `"1.0"`。
- `ping` 不依赖规范化服务。提供者未安装、卸载或依赖递归时，仅组合入口拒绝，插件与无关入口保持运行。
- 输入 `{"text":"  HeLLo  "}`，预期业务输出 `{"text":"FORGE: hello"}`。顶层 Job 仍保留宿主产物封套；反向句柄收到契约业务结果。
- 子调用继承根任务取消、绝对截止点和日志上下文，绑定本次目标代际。请求相同祖先操作、祖先已持独占锁或根调用并发额度耗尽均明确失败。

主代理统一执行，当前未构建或运行：

```powershell
cargo build --release --manifest-path examples/server-service-compose/Cargo.toml --target-dir backend/target -j 1
New-Item -ItemType Directory -Force examples/server-service-compose/bin
Copy-Item -LiteralPath backend/target/release/deviceforge-service-compose.exe -Destination examples/server-service-compose/bin/
npm pack ./examples/server-service-compose
```

通过既有统一安装入口分别安装、加载两个包，再调用 `POST /api/v2/services/example.text.compose/calls`，请求 `{"version":"1.0","input":{"text":"  HeLLo  "}}`。应返回现有 202 Job，通过原任务接口等待成功；MCP 的 `deviceforge.call_service` 加 `id` 字段，复用同一用例。

必要负向验证：仅加载本插件仍可执行 `plugin.service-compose.ping`；组合入口拒绝且不创建假成功 Job。加载规范化插件后组合成功；卸载再重载规范化插件后旧 `generation` 请求拒绝，新目录代际请求成功。取消根 Job 后子调用不得晚到覆盖终态。当前未以源码示例冒充真实部署通过。

## 组合验收与可选标记

宿主及两个示例必须分别构建到共享 `backend/target`，由主代理串行运行，不能只构建后端 workspace。debug 构建去除 `--release`。准备好三份程序后运行 `node backend/scripts/service-composition-smoke.mjs`；release 重建三份后再给该命令追加 `--release`。脚本不执行 Cargo/npm，经真实在线安装接口部署两份原生 TGZ。可用绝对路径 `DEVICEFORGE_SMOKE_BINARY_DIR` 指定三份冻结程序所在目录，完整命令见 [组合验收说明](../../backend/scripts/service-composition/README.md)。

默认不写诊断文件。管理员显式传入 `--smoke-directory <已存在绝对目录>` 时记录本次请求身份、PID、开始/结束与取消状态，不记录业务输入。normalize 的受控等待只影响提供者；消费者继续通过原 ServiceHandle 等待，并使用原上下文取消，不自行建立 HTTP 旁路或常驻进程。标记不能替代宿主清理确认、直接进程及宿主正常退出证明。

验收会验证缺少必需服务仅阻止 compose、ping 保持成功；也会验证提供者版本及代际/schema、HTTP/MCP 同 Job/事件、父子取消退出、提供者活动卸载后恢复和宿主退出。祖先读屏障后的写者排队冲突及 Finished 后完整清理窗口另由主代理定点测试，不由本例的一次成功外推。本轮仅交接源码和静态检查，尚无独立 crate 构建或 debug/release 实服通过结论。
