# 性能会话用例

PerformanceService 注册 android.performance.start / inspect / pause / resume / stop / samples / list / capabilities；输入模式从领域类型生成，HTTP 和 MCP 使用同一任务调度入口。开始任务成功表示采样会话已创建，后台会话状态需独立查询。

生产使用 `registered(store, max_sessions, default_plugin)`，随后以 `bind(&Arc<Application>)` 绑定轻量宿主弱引用，不保留永久平台探针，不形成强引用环。每次 start/capabilities 解析显式默认插件的当前来源；未配置或尚未加载来源时宿主仍可启动，live 请求返回固定 not_found，历史仍可读取。`new(probe, store, max_sessions)` 仅保留既有测试替身兼容。

会话容量为 1–32，默认装配仍为 4，Paused 继续占位；后台采样槽数量等于配置会话数。每会话最多一个在途样本，错过周期跳过，不补采，不占普通 Job worker，也不提交嵌套 Job。创建时同次固定单调会话期限与墙钟开始时间，装配和暂停均计入时长；worker 启动与恢复不延长期限。每 tick 固定 `D=min(准入+10秒,会话期限,能力预算)`，涵盖提交序列等待、采样槽、原执行内核、解码、资格与数据库排队。操作层 `execute_with_context` 将原任务期限传入启动、控制和历史查询。

每会话有独立提交序列，样本 append 与 pause/resume/stop/完成/中断共享该顺序，并继续使用存储 Running/revision CAS。成功样本提交前复核当前源/设备并在短注册锁内登记资格；锁内不做 I/O。数据库使用独立 4 槽工作池；许可、服务与来源 tracker token、序列守卫及样本槽随真实 `spawn_blocking` 闭包存活，外层取消、超时或丢弃 await 不提前释放实际资源。阻塞线程首次 I/O 前重检原期限，已开始的 I/O 可在外层超时后继续收敛；panic 在闭包内登记来源粘性风险。

pause 先提交 Paused/revision，再取消在途样本、通知 worker 并由存储清除 CPU 基线；控制返回表示状态确认，不表示资源已排空。resume 要求原来源/设备仍当前、期限未过、样本已真正排空；仍在收口返回 conflict，已知风险返回 cleanup_failed。Paused/Stopped 等已提交状态不被清理错误覆盖，同态 transition 不补写 error；Paused 风险通过 PluginInfo.cleanup_failed 与 resume 的 CleanupFailed 观察，Running 采样失败可写 Failed/error。恢复首样本无旧 CPU 差分，stop 保留旧终态幂等，取消清理后返回的晚样本不落库。

启动、worker、控制与实际数据库闭包均受 tracker 排空；来源 owner 取消会使 Running、Paused 或启动中的会话收敛 Interrupted，旧终态和 source 不改，新代仅供新会话。会话正常到期 Completed，关闭服务取消并等待 worker、启动/控制任务和仍在执行的阻塞闭包。生产样本复用原执行内核的唯一两秒清理窗口，不另开窗口、不忽略清理结果；风险保持在 owner，不以慢数据库或仅仍在排空直接推断外部清理失败。

启动等待被丢弃时只取消本次装配；成功交付后解除临时守卫，会话不再依赖开始 Job 的取消树。终态写库失败保留待重试历史登记并明确返回错误，不记录为已收敛；后续关闭可重试。实际采样及数据库工作排空后释放来源令牌，历史重试仅归服务跟踪，不向已经卸载的 owner 添加新工作；普通存储失败不伪装成外部资源清理失败。

后台会话与采样 span 固定写入 `session_id`、`source_plugin_id`、`source_generation`；真实插件请求 ID 继续由 ProcessPlugin 写入。字段来自不可变会话绑定，不从当前加载目录补写历史归属。

| 文件 | 职责 |
| --- | --- |
| mod.rs | 构造入口、来源模式、共享会话状态与有界容量 |
| source.rs / source/sampling.rs | 宿主弱引用、来源快照/短登记、既有准入/屏障/执行/解码，由来源实现者负责 |
| storage.rs | 原期限等待、实际阻塞闭包许可与跟踪、只读历史 API |
| lifecycle.rs | 启动装配、控制持久化及通知、终态序列、服务关闭 |
| worker.rs | tick 期限、跳过错过周期、在途样本、资格/CAS 提交及失败收口 |
| operations.rs | 八操作模式、输入解码、原执行上下文与返回封套 |

启动时必须先 recover 存储，重启不假装继续采样。不能同时启动多个服务器共享同一性能数据库。历史会话删除、导出与总磁盘配额仍待实现。

目标验证命令为 `cargo test -p apk-application --test performance` 与 `--test performance_lifecycle`。2026-10-10 应用层库 129 项、既有性能生命周期 3 项及新增生产生命周期 8 项均由主代理实际运行通过，记录在根 `artifacts/performance-application-lib-20261010.txt`、`performance-application-legacy-lifecycle-20261010.txt` 与 `performance-dynamic-lifecycle-20261010.txt`。新增专项使用公开来源装卸、真实开始 Job、条件变量阻塞存储，覆盖原期限、容量/owner/服务排空、晚提交丢弃、风险与终态失败重试；完整当前门禁、服务和真机仍分别验收。
