# 服务器插件公开 SDK 与通信

公开契约位于源码包 `backend/crates/plugin-sdk`，Rust 包名为 `apk-plugin-sdk`；异步运行库位于 `backend/crates/plugin-runtime`，包名为 `deviceforge-plugin-runtime`。它们不引用宿主内部模块。当前指南不假设这些包已发布到 crates.io，也没有可直接安装的官方 Node 插件 SDK；其他语言按相同 JSON 协议实现，Rust 可使用源码路径依赖。

## 单任务协议

`Request` 包含 `protocol_version`、`request_id`、局部 `operation`、`input` 和可选 `artifacts`。例如公开操作 `plugin.guide_echo.echo` 的进程请求 `operation` 是 `echo`。请求与响应使用 UTF-8 JSON，标准输出仅用于协议，诊断写标准错误。

协议 1/2 输入只含一份请求，宿主关闭标准输入；插件输出一份 `Response` 后退出。响应必须匹配版本及请求 ID，显式提供 `result` 或非空 `error` 之一。`result:null` 合法，缺少 `result` 才表示没有结果；不能同时返回错误和输出产物。

```json
{"protocol_version":1,"request_id":"原请求ID","result":{"message":"完成"}}
```

协议 3/4 输入是换行分帧，保持开放接收取消。`CooperativeResponse` 附加 `cleanup`，值为 `complete` 或 `failed`；使用公共运行库生成，不手工猜测握手或清理字段。请求上限 512 KiB，输出与错误各有 1 MiB 上限；插件应在分配大型缓冲前检查限额。

## Rust 协议 4

调用 `serve_once_with_context`，处理器签名是 `FnOnce(Request, InvocationContext) -> Future<Output=Execution>`。运行库解析请求，在发送 Ready 之前固定单调时钟 C0，再根据唯一 Start 的剩余纳秒预算固定截止点。等待 Start 已消耗的时间不能重新授予；预算为 0 表示到期，业务处理器不会执行。

`InvocationContext::deadline()` 返回固定 `std::time::Instant`；`cancellation()` 返回共享取消信号；`check()` 区分到期与取消，二者同时发生时到期优先。阻塞操作放入受限工作池，循环和外部工具都使用同一截止点，不能每层重新计时。需要执行工具时可依赖公开 `deviceforge-tool-process`，不引用宿主基础设施。

处理器返回 `Execution { outcome, cleanup }`。只有所有自有资源已实际清理，才能调用 `Execution::complete(...)`；失败时显式返回 `CleanupOutcome::Failed`。运行库会等待已启动处理器真正返回，收到取消后不能丢弃工作 Future 假装清理成功。源码路径依赖的完整最小入口见 `examples` 主题。

## 产物

协议 2–4 通过清单 `artifacts` 声明输入选择器及输出权。浏览器上传后只传产物 ID；宿主准备输入副本，将 `ArtifactContext.inputs[].path` 和独占 `output_directory` 传给本次进程。插件不要把临时路径作为公开结果或持久标识。

输出文件写到宿主提供目录，再用 `outputs:[{"filename":"result.json"}]` 或运行库的 `Output.artifacts` 声明普通文件名。宿主验证内容后发布，任务结果为 `{"result":业务值,"artifacts":[产物元数据]}`；后续下载或调用继续使用新产物 ID。多输出发布没有事务回滚保证，不声称发生取消或存储错误时已发布文件必定消失。

## HTTP、MCP 与前后端配套

HTTP `POST /api/v2/jobs` 发送 `{"operation":"plugin.guide_echo.echo","input":{"message":"你好"}}`，成功为 202，并在 `{log_id,data}` 中返回排队任务。查询 `GET /api/v2/jobs/{id}`，取消 `POST /api/v2/jobs/{id}/cancel`。失败响应为 `{log_id,error:{code,message}}`，同时保留 `x-deviceforge-log-id` 响应头。

MCP 调用同名操作工具同样提交任务；用 `deviceforge.get_job`、`deviceforge.cancel_job` 和 `deviceforge.job_events` 继续消费。工具查询成功不等于任务成功，必须等到终态。MCP 日志关联位于结果 `_meta["deviceforge/log_id"]`。浏览器插件优先使用公开 `HostContext.listOperations/submit/getJob`，不自行拼接带部署细节的私有路由。

协议 5 是独立会话 API 与 `serve_session` 入口，提供持续输入、EOF、双路输出和明确清理终态；单块字节最多 8192，输出共享递增序号。不要把会话帧发给普通任务操作，不把通信断开或进程退出推断为外部资源已释放。
