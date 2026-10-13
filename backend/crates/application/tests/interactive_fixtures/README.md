# 宿主独立交互会话回归夹具

本目录只测试 application 的公开会话用例与插件代际接线。`interactive.rs` 为集成入口；夹具通过公开 SessionProvider、SessionLaunch、InteractiveSession 和 SessionInput 注入内存传输，不改生产模块、不启动外部进程、不使用私有注册表字段。沿现有 plugin_lifecycle 测试使用内存 SQLite 与 PluginCatalog。

## 文件职责

| 文件 | 负责 |
| --- | --- |
| provider.rs | 纯同步 open、会话声明、独立监督 Future 与准入/执行计数 |
| transport.rs | 原字节双路、共享输入、EOF、取消及结束和监督尾部门闩 |
| support.rs | 纯会话执行器、目录、应用/生命周期装配与有界观察 |
| admission.rs | 纯会话插件、严格 schema 零 open、纯同步准入、代际身份、非法声明原子拒绝 |
| flow.rs | 多路二进制原字节、排他游标、页限额、完成后保留、输入与 EOF |
| lifecycle.rs | 取消/卸载/关闭撤输入并等待、监督尾部、管理等待丢弃、未轮询打开即卸载、未确认清理粘性 |
| capacity.rs | 四活动/八留存、仅终态 remove、十六 MiB 总输出、65536块及非法序号/单块拒绝 |

## 验证方法

SessionProvider.open 只同步创建内存状态、输入与输出通道，不启动任务或文件/进程。current_thread 测试在 open 返回后、调度其他任务前直接核监督计数为零，随后实际驱动监督。每次打开记录原请求，核宿主会话 ID、operation、input 与原截止点；没有普通操作贡献，Executor.execute 计数保持零。

清理门闩让取消信号与监督真正结束分开观察。取消、卸载、服务关闭先撤销输入，克隆输入句柄也立即拒绝发送；监督未释放时保持 Stopping，不允许 remove，卸载/关闭等待保持在途。解除门闩后监督 Future 实际结束，才观察 Finished。另一个尾部门闩在 wait 已能读取终态后继续持住监督 Future，专门证明“有终态缓存”不能提前发布 Finished 或删除 owner 记录。

首次未确认 SessionProvider 标记保留；另一会话成功不能清除它。模拟 Executor 使用默认 has_unresolved_resources=false，避免通过转发把端口接线遗漏掩盖掉。未确认后新打开拒绝、卸载 cleanup_failed、draining 和同 ID 重载拒绝分别断言。

两路输出保留非 UTF-8、NUL、跨块 UTF-8 碎片和原共享序号。after 为排他游标；limit 为1至100，0和101拒绝，after不能超过已缓存 output_sequence。取消终态序号可以高于缓存输出，不能补造丢弃的块或扩大输出游标。缓存和历史保留至显式终态 remove。字节与块限额分别用真实2048个8192字节块和65536个单字节块驱动，拒绝溢出块同时保留已接受前缀。

## 执行和证据边界

主代理协调共享 Cargo 后执行：

```powershell
cargo test -p apk-application --test interactive -- --nocapture
```

初始编写共15项回归。2026-10-12首轮真实命令编译成功、exit101，12/15通过，测试阶段10.06秒；原件为根 `artifacts/interactive-application-first-20261012-150728.txt`。三处首失败保留，不转计修后结果：提供者坏序号的稳定类别为 dependency_failed，而不是用户输入的 invalid_input；夹具结束时误用外部业务取消 token，改为私有输入 token；在持清理门闩时等待串行管理 load 耗尽原十秒卸载期限，改为读取 draining 状态并先丢弃等待者、释放原门闩，再独立重载。未修改生产期限或清理、监督、原字节、容量断言。

第一次修后完整15项复验编译成功、exit101，14/15通过，测试阶段0.24秒；原件为 `artifacts/interactive-application-revised-20261012-151509.txt`，十个冻结测试文件期间零差异。剩余类别由主代理明确裁定：新会话 open 遇到 owner/provider 未确认资源返回 cleanup_failed，HTTP409；不沿用离散历史 conflict。仅修该精确断言，不改生产或粘性拒绝规则。

最终完整15项定点复验已按主代理授权执行，编译和测试均exit0，15/15通过，测试阶段0.25秒；原件为 `artifacts/interactive-application-final-20261012-151829.txt`。修后冻结为 `artifacts/interactive-application-tests-final-frozen-20261012.json`，十个测试文件在最终运行期间零差异；验证和三份日志 SHA256 见 `artifacts/interactive-application-tests-final-verification-20261012.json`。此后仅追加本段实际结果，不扩大为工作区、服务或真进程验收。

内存端口验证应用准入、缓存、监督登记、代际和控制编排，不证明第五版进程协议传输、真实 OS 退出、派生进程、远端资源、终端工具、HTTP/MCP、前端、性能或正式分发。这里的 process_exited 仅是可控端口报告，不能引用为真进程退出证据。
