# 异步工具执行公共库

`deviceforge-tool-process` 面向独立平台插件及宿主进程适配器。它依赖 Tokio、tokio-util 和 thiserror，Windows完整范围监督额外使用windows-sys；不依赖宿主领域、任务、产物存储或任何平台工具。平台命令、工具路径选择、请求限额及插件协议由调用方负责。

## 调用与限额

- `ToolCommand::new(executable, args)` 按独立 argv 执行，不拼接 shell 命令。输入借用调用方准备的字节，发送完即关闭 stdin。
- 默认继承环境；`Environment::Restricted` 清空环境后仅继承 `PATH/SystemRoot/TEMP/TMP/HOME/USERPROFILE`。`env` 提供显式覆盖，工作目录通过 `directory` 指定。受限环境只减少意外继承，不是系统沙箱。
- `ExecutionOptions::new(deadline)` 接收 Tokio 绝对截止时间，输入发送、输出读取、退出等待及文件刷新共享同一截止点。已经取消或过期的调用不启动进程。
- `capture` 并发处理两路输出和输入，每路输出默认 1 MiB，分别计数。返回原字节 `Output`，不裁剪或拼接文本；非零退出返回有界 stderr 和退出码，不直接把诊断写入错误展示。
- `capture_to_file` 用 64 KiB 缓冲写调用方文件；标准输出由 `file_limit` 限制，stderr 仍独立遵守选项限额。已有文件的位置、覆盖方式和部分写入由调用方管理，失败不删除或截断文件。
- `capture_with_lease` / `capture_to_file_with_lease` 在原参数末追加 `Arc<T: Send + Sync + 'static>`，绑定本次目录或其他调用者资源。旧入口和 ExecutionOptions 字段 / Copy 兼容保持。
- `spawn_stream` / `spawn_stream_with_lease` 提供同一直接进程的有界双向流，使用 `StreamOptions::new(execution)`；命令不得设置预置 `input`。会话的可克隆输入句柄支持多次 `send` 和按序 `close`，`recv` 保留带路标的原始字节，`wait` 排空未读输出并返回真实退出状态（含非零）与字节计数。分片、通道、累计输入、输出、期限和取消均有界，详细契约见[流模块说明](src/streaming/README.md)。
- `spawn_scoped_stream` / `spawn_scoped_stream_with_lease` 显式选择 `ScopePolicy::OwnedTree`，返回的 `ScopedStreamExit` 分开报告直接进程和完整范围结果。Windows 在恢复初始线程前完成 Job 归属，清理确认覆盖所有 Job 后代、管道和监督工作；只有 `ScopeCompletion::Complete` 才释放租约。其他平台未取得完整范围资格时返回错误，不把直接 PID 退出算作范围完成，详细实现边界见[完整范围说明](src/scoped/README.md)。
- Windows 子进程隐藏窗口。成功要求直接进程零退出以及输入和输出全部完成。

## 取消与资源归属

取消、超时、输出超限或 I/O 失败后请求终止直接进程，并在独立清理预算内等待退出。默认清理预算两秒，配置只能大于零且不超过两秒；退出未确认返回 `CleanupFailed` 并保留原始原因。调用方应保留未确认状态，不能释放外部资源归属后继续复用。

丢弃执行 Future 会借助 `kill_on_drop` 请求终止直接进程，但无法在被丢弃的 Future 内完成异步等待或返回清理确认。协议 3 的合作清理、派生进程树、共享 ADB/HDC daemon、常驻会话和设备事务不由本库管理，不能以直接 PID 退出声明这些资源已经释放。

租约入口另外由 ownership.rs 持有真实 Child 与资源 Arc。正常返回或错误清理确认 wait 成功后释放；CleanupFailed 或 Future Drop 将所有权交给后台异步 wait，不延长原业务 D 或两秒同步清理窗口。后台等待失败、没有运行时或运行时关闭而丢弃任务时，保守保留 Arc 至宿主进程退出，避免删掉仍可能被工具使用的目录；不能称为已释放。调用者继续限制并发并记录 sticky 风险。目录 Drop 自身的删除成功和派生树仍不由本接缝证明。

宿主 ProcessPlugin 对非合作传输另有清理守卫：工具 Future 丢弃或 CleanupFailed 保留未确认标记，防止外层预算先耗尽时误完成卸载；正常返回且已确认退出的取消/超时不标记失败。此状态归宿主，不进入公共执行库。

流式会话在后台持有 `Owner`。丢弃会话只撤销输入和取消会话子令牌，不 abort 监督；监督继续在既有清理预算内确认直接进程，租约在确认前不会释放。`wait` Future 可丢弃后重新等待，不提前取走监督句柄。监督异常以 `CleanupFailed` 保留未确认语义；运行时关闭不能据此声明已确认清理。工具退出不要求用户先关闭 stdin，慢消费者仍受原业务截止点约束。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `options.rs` | 公开命令、环境策略及截止时间/限额选项 |
| `error.rs` | 与宿主无关的执行错误及数据流标识 |
| `command.rs` | argv、环境、目录、管道和进程属性配置 |
| `streams.rs` | 输入 EOF、有界字节读取与流式文件写入 |
| `execution.rs` | 同一截止时间下的并发 I/O 和退出判定 |
| `lifecycle.rs` | 启动前拒绝与错误后的有界直接进程回收 |
| `ownership.rs` | 直接 Child 与调用者租约绑定、丢弃后的继续持有和真实退出等待 |
| `streaming.rs`、`streaming/` | 独立双向流入口、输入准入、输出分片、后台监督与会话句柄；不改变 capture |

## 验证

在后端目录运行 `cargo test -p deviceforge-tool-process`。真实进程夹具验证参数、字节、环境、目录、限额、取消、超时及丢弃后的直接 PID 退出；它不能替代 Android/Harmony 真机或常驻插件验收。

2026-10-09 主代理实际执行：库定向 35 项通过，工作区 248 项通过（四测试线程），14 模块及 4 架构规则、fmt、Clippy -D warnings、构建通过。宿主已回接且当前 debug/release 与真实 npx 回归通过；分发和未验收范围由根 todo.md 记录。
