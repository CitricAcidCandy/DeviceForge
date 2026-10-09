# Android 性能采样与持久化

AndroidPerformance 仅执行管理员配置的 ADB，使用固定 pidof -s、cat /proc/<pid>/stat、dumpsys meminfo -s 和 cat /proc/stat。包名、设备编号不接受 shell 运算符。一次采样共用 10 秒期限，沿用有界输出、超时、取消和进程清理。

内存前后读取进程 stat 并比较启动时间，拒绝采样期间 PID 复用。stat 通过最后一个右括号定位字段，允许进程名含空格与括号；只使用 utime / stime，不包含子进程。系统 CPU 加总前八项，guest 已在 user 内、guest_nice 已在 nice 内，不重复累计。PSS 兼容 TOTAL 表行与 TOTAL PSS 摘要，RSS 缺失为 null；矛盾摘要、错误 PID、权限错误、非零退出不报告成功。

SqlitePerformance 用独立 performance.db，WAL、事务和版本检查保证暂停以后晚到样本不写入。CPU 原始基线与样本同事务提交，状态变化重置基线；样本按会话 / 序号索引。恢复按 100 项批次终止遗留 running / paused，会话 205 项恢复测试覆盖跨页。

实际设备可能限制 /proc 读取，需要真机权限验收；dumpsys 格式差异需样例扩展。指标采集顺序执行，不是原子快照；主进程采样不含所有同包进程。PSS / RSS 单位 KiB，不作堆内存或全包内存替代。FPS 尚待独立采样适配。

验证：cargo test -p apk-infrastructure performance；node scripts/runtime-smoke.mjs。fixtures 是真实独立模拟进程，不是真机验证。