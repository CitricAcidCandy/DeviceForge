# 客户端工具与文件排空

主Control复用公开工具库及既有ToolGuard，直接工具进程退出确认不提升为目录清理确认。`resources.rs`保存单调用工作许可、目录/输出所有权、同次清理点和等待丢弃标记。

`capture_private` 为 APKS 指定部署 Java 与固定 argv，将 cwd 和 TEMP/TMP/TMPDIR 设为本次私有目录；复用 `capture_scoped_command` 的 Restricted 环境、两流各 1 MiB、直接进程租约、原业务截止点和固定清理点。普通 ADB 的 `capture_scoped` 行为保持原合同，私有入口不构造平台参数。

性能五命令直接复用 `capture_scoped`，每笔保持Restricted、两流各1MiB、相同原业务截止点与真实直接PID退出确认，不建立另一套进程控制或阶段计时。解析由Session的既有单槽worker处理，工具控制层不解析性能文本或声明产物。

`file.rs`用独占任务持实际截图文件和目录租约，经公开capture_to_file_with_lease完成捕获，再flush、into_std等待内部I/O排空并关闭真实句柄。等待被丢弃只通知取消和标记未确认，不abort文件任务或自动删除工作目录。

等待守卫仅持弱租约，丢弃时固定本次清理点；文件任务内部测试直接检查实际写入、flush、关闭、丢弃等待和panic后粘性未确认。测试源码不等于已执行证据，由主代理统一编译与运行。

原业务截止点不刷新；取消/到期的首次本地观测固定清理点。普通工具错误已经由公共库回收直接客户端后，再开始目录删除确认，不把正常工具等待耗时当清理耗时。共享ADB daemon、远程连接和设备事务仍属于部署者责任。

Java 真实退出只证明本次直接客户端退出；不将其扩大为 bundletool 派生 ADB 树或共享 server 的退出保证，不在本层新增 kill-server、disconnect 或设备回滚。
