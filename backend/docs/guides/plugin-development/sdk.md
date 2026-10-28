# 服务器插件公开 SDK 与通信

## 公开错误必须说明实际问题

- 沿用现有协议和错误码，将可理解的具体原因写入现有错误文字；不能只返回“依赖失败”“代际撤销”、状态码或日志编号。
- 明确说明出了什么问题，以及使用者接下来能做什么。示例：“当前设备未安装此应用，请选择已安装应用，或先完成安装”“设备尚未授权，请在设备上确认连接授权”。
- 应用未安装、无启动入口、设备离线、未授权、连接工具无法启动、插件更新与真实资源占用分别处理；不能一律归咎于部署配置。
- 无法确认原因时明确写“目前无法确认具体原因”，不能凭通用退出码猜测。受控只读辨因继承原调用的取消和期限，不得重发启动、安装等有副作用动作。
- 清理未确认只说明对应任务的风险，不能提示先恢复整个插件才允许无关操作。保留机器错误码、任务和日志关联；不透出任意工具输出、凭据、私有路径或请求体，不改写历史日志。

插件通过公开 JSON 协议接入，无需获取宿主源码。Rust 可选公共库名为 `apk-plugin-sdk` 与 `deviceforge-plugin-runtime`；只有取得可独立消费的 SDK 开发包后，才按该包实际提供的版本和依赖方式接入自己的工程。当前不假设这些库已发布到 crates.io，也不假设存在官方 Node SDK；未取得开发包时可使用本指南 `examples` 中无 SDK 依赖的完整 Node.js 示例，不应猜测下载地址或要求访问宿主仓库。

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

处理器返回 `Execution { outcome, cleanup }`。只有所有自有资源已实际清理，才能调用 `Execution::complete(...)`；失败时显式返回 `CleanupOutcome::Failed`。运行库会等待已启动处理器真正返回，收到取消后不能丢弃工作 Future 假装清理成功。`examples` 主题给出 Rust 处理器示意，使用它前须取得独立 SDK 开发包；可直接运行的无 SDK 示例为同主题的 Node.js 协议 1 包。

## 产物

协议 2–4 及 6 通过清单 `artifacts` 声明输入选择器及输出权。浏览器上传后只传产物 ID；宿主准备输入副本，将 `ArtifactContext.inputs[].path` 和独占 `output_directory` 传给本次进程。插件不要把临时路径作为公开结果或持久标识。

输出文件写到宿主提供目录，再用 `outputs:[{"filename":"result.json"}]` 或运行库的 `Output.artifacts` 声明普通文件名。宿主验证内容后发布，任务结果为 `{"result":业务值,"artifacts":[产物元数据]}`；后续下载或调用继续使用新产物 ID。多输出发布没有事务回滚保证，不声称发生取消或存储错误时已发布文件必定消失。

## HTTP、MCP 与前后端配套

HTTP `POST /api/v2/jobs` 发送 `{"operation":"plugin.guide_echo.echo","input":{"message":"你好"}}`，成功为 202，并在 `{log_id,data}` 中返回排队任务。查询 `GET /api/v2/jobs/{id}`，取消 `POST /api/v2/jobs/{id}/cancel`。失败响应为 `{log_id,error:{code,message}}`，同时保留 `x-deviceforge-log-id` 响应头。

MCP 调用同名操作工具同样提交任务；用 `deviceforge.get_job`、`deviceforge.cancel_job` 和 `deviceforge.job_events` 继续消费。工具查询成功不等于任务成功，必须等到终态。MCP 日志关联位于结果 `_meta["deviceforge/log_id"]`。浏览器插件优先使用公开 `HostContext.listOperations/submit/getJob`，不自行拼接带部署细节的私有路由。

协议 5 是独立会话 API 与 `serve_session` 入口，提供持续输入、EOF、双路输出和明确清理终态；单块字节最多 8192，输出共享递增序号。不要把会话帧发给普通任务操作，不把通信断开或进程退出推断为外部资源已释放。

## 托管配置与工具资源

完整发布将 `release.json` 的 `tools/entries/bindings` 转成不可变资源描述，宿主以 `DEVICEFORGE_PLUGIN_RESOURCES` 传入该描述文件的绝对路径。Rust 用 `apk_plugin_sdk::managed_resources() -> io::Result<Option<ManagedResources>>` 读取，再用 `resources.entry("工具ID","资源键")?` 得到本次绑定入口；不要解析宿主安装记录或拼接 `tools/<版本>`。旧部署没有变量时为 `None`，变量存在但描述损坏则报错，不能静默回退。

描述包含 `format_version:1`、`release_id/revision/tools/bindings` 和可选 `repository`。需供应共享内容时使用公开仓库描述与 `deviceforge-tool-repository`，不绕过写锁、引用和调用读租约。工具供应 managed 模式允许省略/null 安装根；custom 或旧未声明模式必须提供本机合法绝对根，旧目录不自动搬迁。

`DEVICEFORGE_PLUGIN_CONFIG` 指向宿主为本次调用选择的有效配置快照，SDK 的 `managed_config_path()` 可定位。用户配置原值和修订保存于用户根 `plugin-configurations/server`；托管绑定只补默认入口，用户高级显式路径优先，schema 必需 const 可在有效快照补齐但有歧义时失败。更改工具默认值不覆盖已保存的原值；不要把该快照、描述文件或绝对入口返回给浏览器。独立运行的旧旁置配置继续兼容，必要输入与敏感值满足性须由宿主原值门禁判断。

## Rust 公共服务与协议 6

公开运行入口为 serve_once_with_services/serve_io_with_services，处理器接收 Request、InvocationContext、ServiceClient 并返回 Execution。services.service::<Input,Output>(ServiceRef{id,version}) 创建 ServiceHandle，call(&input).await 经宿主端口调用；version 是精确字符串，例如 1.0，不转数字。调用 Future 丢弃触发 service_cancel；截止点、取消与清理不可重新授时。宿主 HTTP/MCP 提交继续返回原有 Job，不通过 HTTP 旁路调用插件。

GET /api/v2/services 返回 ServiceInfo 数组；POST /api/v2/services/{id}/calls 请求 {version,input,generation?}，响应 202 Job。HTTP v2 含 log_id/data；generation 可选，指定时拒绝换代。服务声明与取消、期限和清理约束分别查询本指南的 `manifest`、`lifecycle` 主题，实际可用接口以连接宿主的目录为准。
