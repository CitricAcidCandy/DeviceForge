# 进程合作清理

cooperative.rs 专门实现协议 3，复用父模块的 argv、令牌隔离与输出上限。开放 stdin，取消/总期限到达时发控制帧，最多 1250 ms 等待原输出读取 Future 收敛；完整响应、匹配请求、零退出和 complete 才确认清理。失败后最多 500 ms 终止直接子进程，释放 Future 仍有 kill_on_drop 兜底。

CleanupGuard 对无确认或 Future 丢弃持续标记未确定资源，强制杀直接进程不能证明外部设备会话已释放。历史诊断由公开管理接口保留，不因此冻结无关新任务或新代；实际活动互斥与容量继续生效，不提供猜测式清除标记。协议 1/2 的 EOF 和 60 秒行为保持不变。

`cooperative/services.rs` 实现显式协议 6 的反向服务调用，子调用通过领域端口进入现有任务执行上下文，继承父取消和绝对期限。业务 `Finished` 后保留完整 1250ms 子调用清理窗口。`cooperative/service_stdin.rs` 在输入 shutdown 就绪时释放实际管道句柄，使插件收到 EOF 后退出；Pending 保留句柄，关闭错误原样返回，防止仅调用空操作 shutdown 后互相等待退出。服务版本、Schema、代际和调用边界见[公共服务与协议第六版](../../../../docs/contracts/公共服务与协议第六版.md)。

固定日志记录 cleanup 状态，不记录控制帧、请求体、路径或插件输出。真实进程覆盖位于 plugins/cooperative-demo/tests；它证明模拟资源标记，不证明 Frida 或真机清理。
