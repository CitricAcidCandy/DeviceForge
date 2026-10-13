# 私有原生监督

`--sdk-supervisor` 与 `--sdk-sentinel` 在建立任何 Tokio 运行时之前同步分派。监督入口为独立进程，所有 `waitpid` 和原生状态只作用于本调用，不在宿主或普通插件全局抢占其他工具进程。外层仍由公开 `OwnedTree` 持有；内部候选和范围退出帧不能替代外层实际退出。

- Windows：暂停创建 Node，绑定本调用 Job 后恢复主线程；强杀一次并核对成员计数与 Node 实际退出。
- Linux：独立主线程设置 subreaper，sentinel 维持受控进程组身份，Node 与 sentinel 持有出生后的稳定 pidfd；结合 pidfd 实际退出和 `waitpid` 回收至 `ECHILD` 后才确认范围为空。pidfd 不可用、组身份丢失、查询失败、成员未回收或清理超时均失败，不能用发送信号成功充当退出证明。
- macOS：暂停出生、受控组、kqueue 和成员查询仍为私有实现入口，须补出生身份与原生故障证据；不使用 XNU 已不支持的 `NOTE_TRACK` 宣称完整后代资格。

Linux helper 要求内核提供 pidfd，当前实现可从独立监督入口运行；公共工具库尚未为 Linux/macOS 开放完整范围执行，插件生产路径仍返回不可用。当前 Windows 实际结果也不能扩展为三平台全部完成。原生故障、强杀、成员逃逸、派生树及真实模型执行必须分别记录。
