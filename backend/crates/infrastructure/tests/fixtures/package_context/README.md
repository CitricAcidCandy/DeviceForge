# 三个包操作的公开 context 黑盒回归

状态：测试源码已落盘，尚未编译或执行，由主代理接管格式化与真实运行。本目录和 `tests/package_context.rs` 是独立写集，不修改生产、已有 `tests.rs`、核心验收夹具或根 smoke。

## 入口与职责

通过公开 `AndroidPackageTools::new` 与领域 `PackageAnalyzer::{manifest,signature,extract_apk}_with_context`，传入原 `ExecutionContext.deadline: Option<std::time::Instant>`。真实种子上传和结果下载直接使用本次 `FileArtifacts`；包装的 `ObservedStore` 只计被测 download、put 进入和发布完成。精确拒绝路径分别检查零调用，不把种子上传计成执行发布。

| 文件 | 职责 |
| --- | --- |
| `../../package_context.rs` | 集成测试模块入口 |
| `mod.rs` | 临时仓库、独立模拟工具编译/命令、执行器启动、时钟观测、失败保留 |
| `store.rs` | 公开 ArtifactStore 包装；download 返回前、流首块、put 实际发布前的可取消门闩 |
| `samples.rs` | 独立 XML/签名固定文本与输入 ZIP；不调用核心来生成期望 DTO 或下载字节 |
| `tool.rs` | 无第三方依赖的真实 Rust 工具；校验固定 argv、读取授权副本、ready/hold/有限输出/非零退出 |
| `deadlines.rs` | 三流预拒绝、准备扣时、真实工具及发布期限/取消 |
| `outputs.rs` | XML 三个命名空间实体场景、完整 DTO、签名脱敏、提取原字节及旧错误对照 |

PID 存在性只读复用 `tool-process/tests/support/liveness.rs`，不改该文件、不发终止信号。本次控制目录唯一，工具入口写 `started.pid`，校验输入后原子发布 `ready.pid`；正向和取消用例分别实际查询该直接 PID 是否退出。`response_written/exit.code` 只是工具意图，不能单独证明进程已经结束。没有 shell、派生进程树或外部资源清理保证。

## 28 个独立测试

`deadlines.rs` 共 17 项：

- 预过期三项、预取消三项：download/put/发布全部为零，工具 main/ready/argv 标记不存在；另有一项三流同时预过期与预取消，严格 Timeout 优先。
- 慢 download 三项：真实进入下载门闩后原 D 到期，返回 Timeout；随后打开门闩不补跑工具或发布。
- 慢流正文一项遍历三流：已取得真实下载流，首块仍 hold；原 D 耗尽，工具与发布均零。
- 实际工具原 D 到期两项：manifest/signature ready 后仍 hold，到期严格 Timeout，直接 PID 实退、无响应或发布。
- 准备耗时扣除一项：冻结宿主时钟，download 消耗原 60 秒中的 45 秒后真实工具 ready；只剩 15 秒，到原 D 严格 Timeout，未重获工具窗口。
- D 前显式取消一项：实际签名工具 ready，宿主时钟到原 60 秒中的第 59 秒，仍在 D 前取消；严格 Cancelled、直接 PID 实退、零发布。
- 提取发布两项：完整复制后 put 进入但尚未真实发布，分别原 D 到期/主动取消；严格 Timeout/Cancelled，放开门闩不能晚提交，计数为 download=1/put=1/published=0。

`outputs.rs` 共 11 项：

- 清单完整旧 DTO 与真实 argv；未定义 xmlns 实体精确 Dependency；等价 Android URI 解码后保留完整 DTO；等价前缀同属性重复精确 Dependency。
- 签名完整 DTO/排序/None 与展示名替换，不泄露真实副本路径；退出零但不完整报告精确 Dependency。
- 正常精确提取：本次真实发布唯一 `extracted.apk`，source/entry、大小、独立 SHA256、真实元数据和下载原字节全部匹配；无工具启动。
- 缺项精确 NotFound，四类不安全/非 APK 名精确 Invalid，无发布；只破坏选中正文的 CRC 坏包精确复制阶段 Invalid，无发布。
- AAB 默认 base/显式 feature 与 APK module 精确拒绝；每次成功工具调用使用不同控制目录，避免旧 PID/ready 冒充。
- 非零工具退出严格 Dependency、真实 PID 实退、退出意图为 7；不接受任意错误类别。

## 时间与未覆盖边界

夹具编译和种子真实 I/O 在业务 D 创建之前完成。暂停时钟用例持续 `yield_now` 观测真实 entered/ready，防止 I/O 等待自动推进 Tokio 时间。先验证数学原截止点，再单独推进 1 毫秒供 timer 刻度唤醒；传入 context 从不重算。真实进程清理前恢复时钟，允许 OS 清理等待正常计时。

暂停时间只证明宿主调度与原 D 的传播，不表示真实工具耗时 45/59/60 秒，也不直接证明同步核心内部每个检查点的墙钟时刻。两个真实 Timeout 用例使用 8 秒业务 D；30 秒墙钟看门狗仅防卡死，10 秒 PID 退出观测不是新的生产清理窗口。hold 工具自身 60 秒安全门闩仅防失败遗留无限运行；不能用其自退出冒充宿主正常清理。

私有四槽 Pool、Drop 后 worker/目录 lease、成功资格与 tracker 的内部竞争由主代理单测负责，本套件不重复，不访问 hook。这里没有 Application Job、HTTP/MCP、协议 3 清理确认、npx、真实 Android 工具、可安装 APK 或真机验收；合成 ZIP 仅证明本次结构和字节链。

测试失败或本次工具仍存活时保留 `package-context-*` 根，包含实际 argv、PID、副本路径及有限样本；只打开本次 release 门闩，不强杀未知 PID。OnceLock 编译的工具临时目录在该测试进程内持续持有，不把它计为业务 scratch 已回收。

主代理可在冻结后串行运行 `cargo test -p apk-infrastructure --test package_context`，并纳入 fmt/Clippy 与全量测试。测试助理本次未运行 Cargo/rustc/格式化/服务，也未运行该自包含工具。
