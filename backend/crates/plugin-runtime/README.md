# 公开异步插件运行库

deviceforge-plugin-runtime 只依赖公开 SDK、Tokio 与 JSON，不引用宿主领域、用例、存储或 HTTP。适用于每任务一个进程、需要在取消前执行自有资源清理的插件；不实现设备提供者、常驻 RPC 或业务规则。

serve_once(handler) 从标准输入读协议 3 Request，将请求与 CancellationToken 交给异步处理器。stdin EOF、取消或坏控制帧会通知取消；处理器先清理，再返回 Execution 与明确 CleanupOutcome。Execution::complete 只能在清理成功后调用，失败必须返回 Failed。标准输出仅写一份有界 CooperativeResponse，不使用它打印业务日志。

framing.rs 先限制缓冲再读取换行帧，请求 512 KiB、控制 4 KiB；响应 1 MiB，超大结果转为固定错误。serve_io 支持注入异步读写用于测试。主机断开后输出可能失败，但处理器清理先于输出。

样例见 ../../plugins/cooperative-demo；`cargo test -p deviceforge-plugin-runtime` 覆盖正确取消、EOF、坏/错配/超大控制、初始帧限制、晚到成功拒绝、清理失败及响应上限。实际外部连接是否释放由业务插件和真机验收证明，运行库只传递信号与声明。
