# 性能会话用例

PerformanceService 注册 android.performance.start / inspect / pause / resume / stop / samples / list / capabilities；输入模式从领域类型生成，HTTP 和 MCP 使用同一任务调度入口。开始任务成功表示采样会话已创建，后台会话状态需独立查询。

会话占用独立信号量，服务器当前最多 4 个，不占用通用任务工作线程长期等待。采样采用跳过错过周期的定时器，单次上限 10 秒；暂停取消当前采样并拒绝旧版本样本，恢复重新建立 CPU 基线。暂停时间计入总时长，到期 completed。启动 / 控制的持久化与通知在独立任务内完成，调用 Future 丢弃不会把装配中断在一半。

数据库访问通过独立 4 槽信号量与 spawn_blocking，不阻塞异步运行时；许可保留至阻塞闭包结束，并传播请求或会话日志上下文。后台采样器异常捕获后转 failed，容量释放；正常关闭等待各会话退出并转 interrupted。实际端口须在取消时清理资源；用例给予最多 2 秒清理窗口，随后丢弃不合作 Future。显式 stop 是持久化状态确认，子进程资源清理可能稍后结束。

启动时必须先 recover 存储，重启不假装继续采样。不能同时启动多个服务器共享同一性能数据库。历史会话删除、导出与总磁盘配额仍待实现。

验证：cargo test -p apk-application --test performance，覆盖开始、容量、暂停 / 恢复、晚到样本、停止、到期、关闭、异常、预取消和模式校验。
