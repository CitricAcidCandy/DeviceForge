# Harmony 应用动作

本模块实现 HDC 应用详情、启动、停止与数据重置。`app.detail` 固定查询 `bm dump -n bundle`，直接返回完整 JSON 对象，保留未知字段，不要求可启动模块。`details::parse` 负责标题、UTF-8、根包名和受限 JSON；`details::ability` 另负责首模块能力推导。

`start` 允许省略 `ability`，此时沿同一原调用截止点复用详情查询，再验证首模块的 `mainAbility` 并启动。解析复用 `Control::work` 的工作槽和租约，查询与启动不重新授予预算。

停止和重置只执行各自固定 argv。三个动作都要求零退出、两流 UTF-8、独立完整成功行，并返回 `{output}`；应用动作完成不代表桌面或进程状态已由插件观测确认。
