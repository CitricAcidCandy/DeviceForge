# 性能采样领域端口

PerformanceProbe 返回目标主进程的累计 CPU 计数、进程身份、逻辑核数、PSS 和可选 RSS。PerformanceStore 提供持久化会话、版本化状态流转、样本追加和分页。领域不引用 ADB、SQLite、HTTP 或操作系统进程。

`source.rs` 定义执行器的可选来源声明及会话不可变来源引用。公开会话增加可选 `source`，旧 JSON 缺字段仍可读，缺省值在序列化时省略；独立兼容来源不填设备引用，设备型来源使用既有 `DeviceRef`。`Executor::performance_source` 默认无贡献，来源注册、准入、排空与存储排序由应用层实现；类型存在不表示动态生命周期已经完成。

PerformanceStart 限制采样间隔 1000–60000 毫秒、总时长 1–3600 秒；设备编号与包名严格验证。CPU 必须比较相邻的同 PID、启动时间与核数样本；首次采样、暂停恢复、进程变化、计数回退或差值无效时为 null，不报告虚假零值。cpu_share_percent 为全机 CPU 容量占比，cpu_core_percent 为单核归一化百分比，可超过 100。

状态为 running、paused、stopped、completed、failed、interrupted，终态不能恢复。样本序号从 1 递增，分页最大 100；每会话最多 3600 项。FrameWindow 是可选帧数 / 时长 / 来源，验证后计算可选 FPS。内置采样器不支持 FPS，公开采样插件按能力声明提供，未观测时省略窗口；capabilities 动态报告来源。

验证：cargo test -p apk-infrastructure performance；cargo test -p apk-application --test performance。
