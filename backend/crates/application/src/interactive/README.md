# 宿主交互会话

本模块通过领域SessionProvider管理持续会话，不复用普通Job的终态提交。`mod.rs`负责准入与公开用例，`entry.rs`负责有界输出记录与公开终态，`input.rs`负责准备等待、输入顺序及限额，`supervision.rs`分别监督提供者与输出消费。

会话固定插件ID和代际，原子登记应用及owner跟踪。监督独立于消费者运行，消费者失败不abort资源监督；两者全部结束后才发布Finished。服务关闭和卸载撤销输入并等待，未确认清理粘性保留。只有Finished记录可以显式删除。

默认8条保留记录、4条活动会话。完整保留策略 `complete` 的每条输出最多16MiB、65536块，超过限额失败；显式 `bounded_tail` 使用同样大小的尾部窗口，由 `output_cache.rs` 淘汰最早输出块。两种策略单块均最多8192字节，保留实际输出序号，不因淘汰重新编号。输入累计1MiB、65536次，空输入不是EOF。

排他输出游标配合1至100块页长。完整模式保留原字节直到删除；尾部模式只保留窗口，游标落后于窗口返回 Conflict，不能静默从媒体半帧恢复。客户端须显式处理过期并重建媒体会话。输出消费与资源监督独立，慢读不阻止监督收口。

`open_session`是同步、无进程或文件副作用的准入，返回Opening记录；真实打开在后台进行。`session`查询状态，`session_output`读取输出；`session_send/session_eof`等待真实准备及受限输入准入，成功不证明工具已消费。`session_cancel`请求停止，`session_remove`删除已结束的内存记录。会话不持久化、不自动重连或回放，服务重启后旧ID不存在。

`session_release`供 HTTP `POST /api/v2/sessions/{id}/release` 与 MCP `deviceforge.release_session` 共用：用户明确结束会话后，所有已结束记录均可立即移除，不因历史清理失败返回409；返回值仍保留原清理结论，不伪造Complete。活动会话立即撤销输入并返回Stopping，真实监督结束后无论清理结果如何都回收工作台记录，避免失败历史永久占用界面和容量。资源风险及恢复报告继续由插件owner独立保存，移除内存记录不是外部资源已释放的证明；202也不是清理完成回执。

所属方案及证据边界见 `backend/docs/implementation/宿主交互会话实施.md`。独立内存端口回归与真实插件、HTTP/MCP、浏览器、派生进程树或远端清理分别验收。
