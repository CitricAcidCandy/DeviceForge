# 独立交互会话领域端口

本模块只包含纯类型、规则与可替换端口，不依赖 SDK、Tokio 进程、HTTP 或基础设施。`Executor::session_provider()` 默认返回 None，旧执行器与 `PluginContribution` 的构造保持兼容。一次会话承载多次输入，不为每个输入创建普通 Job。

## 声明与打开

`SessionDefinition` 包含完整 `id`、`title`、打开参数的 `input_schema` 和可选 `execution`。`validate(plugin_id)` 限定所属命名空间、完整名称长度、对象模式、文档内引用与预算；注册层还须编译模式、拒绝重复贡献并固化有效预算。`protocol_version()` 固定返回 5，`chunk_limit()` 固定返回 8192；所有会话支持原字节输入、stdout/stderr、EOF 与取消，不声明伪终端或多会话复用。

`SessionRequest` 包含 `session_id`、完整 `operation`、打开参数 `input` 与必须给出的单调时钟 `deadline`。原截止点覆盖排队、准备、打开、握手和业务，不因 Ready/Start 重计。

`SessionProvider::open(request, cancel)` 只同步构造 `SessionLaunch { handle, supervisor }`，不启动进程或访问文件。应用须在原子资格判断时固定所属 Owner 与 generation，并将 supervisor 登记到该 owner 的 tracker，随后锁外运行。tracker 必须覆盖整场监督，不能只跟踪 open。

## 输入、输出与终态

- `input()` 返回独立共享输入端口，允许接收输出时同时发送输入。send/eof 共用有界准入顺序与累计限额；等待容量时保留背压，预留后再复制，尚未准入的等待被丢弃不产生副作用。成功只确认准入。
- 空输入不是 EOF。eof 关闭协议输入，保留控制传输；重复 EOF 或 EOF 后输入返回错误。
- cancel 同步、幂等撤销输入，走独立优先控制通路，不等待数据队列。在途帧已经写出部分字节时须完整收口或确认传输失败，不能拼入 Cancel。
- ready 缓存握手成功或共享错误。recv 取消安全，未完成的接收被丢弃不取走输出；None 只表示输出结束。
- wait 排空并丢弃未读输出以免背压阻止结束，同时等待后台监督结论。等待 Future 被丢弃后可以重等；完成后重复返回同一 `Arc<SessionExit>`。真正 Finished 序号单独缓存，取消丢弃输出后不重新编号。

`SessionResult<T>` 使用 `Arc<Error>` 缓存错误，不给全局 Error 增加 Clone。`SessionExit` 分开保留有效插件 outcome、宿主首次 failure、直接进程退出状态和 cleanup；业务失败、传输失败及清理结论不能互相覆盖。outcome 中的 artifacts 只能是宿主已发布产物，失败或未确认清理不得发布。

清理状态含 Complete、Failed、Unconfirmed：只有匹配有效 Finished 明确报告 complete，且直接进程成功退出后才记 Complete；有效 Finished 明确报告 failed 时记 Failed；缺失或坏终态、强杀、非零退出或监督丢弃记 Unconfirmed。sequence 仅在匹配有效 Finished 后有值，不能从输出数量猜测。process_exited 仅证明直接进程退出，不证明派生进程或远端资源释放。

## Drop 与宿主监督

客户端接收句柄 Drop 只请求合作取消，不能 abort 后台监督；其输入克隆须一并撤销。后台继续持有 Owner、tracker 登记和产物租约，直到真实确认。未确认结论须粘性写入 provider/owner 的 unresolved，后续成功不能清除，卸载完成和同 ID 重载必须继续拒绝。

业务 cancel 和原业务 deadline 不能直接交给底层进程流监督，否则插件在合作清理前被杀。适配器保留独立强制取消与硬期限，为合作清理、Finished 传输和真实退出留有界宽限；宽限结束仍未确认则强制收口并保留 Unconfirmed。丢弃 wait Future、接收结束、发出强杀或子进程退出都不能自行证明外部清理完成。

`definition.rs` 负责声明纯规则，`model.rs` 负责输出及终态类型，`ports.rs` 负责句柄和监督契约。纯规则测试不代替进程、宿主卸载、HTTP/MCP 或真机验收；这些行为由后续适配器和应用集成验证。
