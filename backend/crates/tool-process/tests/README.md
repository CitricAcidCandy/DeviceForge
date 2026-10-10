# 公共工具进程真实行为测试

入口是 `tests/behavior.rs`，仅使用 `deviceforge-tool-process` 公开 API；源文件按捕获、环境、生命周期、文件输出和公共夹具支持拆分。`tests/fixtures/process.rs` 是自包含标准库 Rust 进程，不依赖宿主、不执行 shell 或设备平台命令、不派生后台进程。

## 运行与交接

本次由测试助理只编写测试源、静态核对文件引用和 UTF-8，不执行 Cargo、fmt、rustc、服务或真实进程验收。主代理待本目录冻结后在 `backend` 统一串行执行：

```powershell
cargo fmt --all
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
$env:RUST_TEST_THREADS = '4'
cargo test -p deviceforge-tool-process --test behavior
```

主代理按工程既有流程负责工作区全量测试和构建。此处没有声称编译或行为已经通过；真实结果以主代理执行的退出码和测试数量为准。

测试第一次使用夹具时通过 `OnceLock` 编译一次，编译完成后才创建业务截止点。夹具产物写入 Cargo 的测试临时目录（若不可用则系统临时目录），包含当前测试宿主 PID 和时间戳，供失败复查；不会修改源码或覆盖其他测试产物。单用例资源由 `tempfile` 独占，失败时如果本次 PID 仍存在则保留标记目录，不按 PID 强杀。

## 覆盖

- 独立 argv 保留空参数、空格、中文、引号、反斜线及 shell 特殊字符，核对逐项二进制帧且不存在 shell 副作用。
- 二进制 stdin/stdout，包括零字节和非法 UTF-8；无 stdin 时明确 EOF；两路同时超过管道容量仍能收敛。
- stdout/stderr 单独限额，两路恰好等于限额成功，分别超出一字节返回精确 `OutputTooLarge` 与数据流；`u64::MAX` 限额不发生加一溢出。
- 非零退出固定为 `NonZeroExit`，保留退出码 23 和原始 stderr 字节，不误计为成功。
- 默认继承环境；Restricted 只保留六项固定允许变量及显式 env，显式 env 可以覆盖 PATH；带空格中文 cwd。只观测变量名称和本次测试显式值，不输出其他继承内容，不修改测试宿主全局环境。
- 预取消和过期绝对截止点不启动；取消与到期同时就绪时优先取消。cleanup_timeout 为零或大于两秒分别返回 `InvalidOptions` 且不启动，默认两个独立 1 MiB 限额、两秒清理预算。
- running cancel、绝对超时及已轮询 Future 丢弃后的实际 PID 退出。2 MiB stdin 对不读取输入的 hold 工具产生背压，取消和截止点仍覆盖 write_input；ready 后不重启相对 timeout。
- 文件输出复用同一限额规则：file_limit 覆盖普通 stdout_limit；文件恰好等限额及超一字节、stderr 精确边界、最大 u64 限额、二进制输入、非零退出和只读文件 `FileIo`。
- 文件在进程仍运行时可见流式字节；取消后保留有界已写部分并确认 PID 退出；大型未读取 stdin 可取消、文件 Future 丢弃、文件模式预取消/过期及非法清理预算。

## 时序和边界

正常业务测试预算 60 秒，ready 观察 15 秒；超时和同时就绪优先级用原始绝对 20 秒截止点，给实际启动留足时间。取消先等原子 ready PID 标记，避免使用“睡很短再猜已经启动”。丢弃 Future 后最多观察 10 秒退出，不用计时器取消替代真实 PID 证据；库取消/超时返回时要求直接 PID 已退出。

PID 探测在 Windows 使用只等待权限的进程句柄，在 Unix 使用信号零，仅检查存在性。测试不发送终止信号、不声称派生进程树回收，也不将直接进程退出扩展为设备或其他外部资源已恢复。夹具两分钟保险退出不能使及时清理断言通过；测试有意让库承担实际回收。
