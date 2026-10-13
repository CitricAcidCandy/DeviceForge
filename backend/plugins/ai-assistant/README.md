# AI 测试助手业务插件

旧 CaseAssistant 的 CLI 单次请求和 CLI 恢复轮次迁入 `plugin.ai-assistant.cli.single/cli.turn`；状态入口为 runtime.status。请求携带已配置 project_id 与 prompt，turn 可使用规范 UUID thread_id。部署者配置工具入口、附加 argv、项目映射及专用 environment；提示词经 stdin 传递，不拼接 shell，不默认复制旧危险 CLI 参数。

执行使用固定期限和现有 Job 取消。JSON 事件必须有 turn.completed 和实际 agent_message，失败事件、缺失完成、非法 UTF-8 都返回失败；结果保留 text、thread_id、events 与 project_id。状态 configured 只说明配置已读，不证明已认证或模型可用。凭据只来自本插件部署配置，不从宿主环境继承，不输出部署配置或 stderr。

会话元数据保存在部署配置的 state_root（默认配置文件旁 ai-state），原生 UUID 统一小写；记录线程、项目及规范目录归属、轮次和关闭状态。文件锁跨插件进程持有到本轮实际退出，恢复未知线程或跨项目线程会失败。轮次启动前持久化 uncertain，取消、工具失败或服务硬终止后不自动重放可能已产生副作用的提示词；session.get 可查询，session.close 在当前轮次退出后关闭本地恢复资格，不删除提供者历史。两个操作输入为 project_id/thread_id，输出 turns 为十进制字符串及 closed/uncertain。

Windows 在原目录及链接检查通过后规范化现存 threads 目录，锁、临时文件和提交目标从同一规范长路径派生。深目录下首次登记、恢复轮次及关闭保持原子替换规则；提交前取消或真实替换失败保留原文件和内存状态，并回收临时文件。长路径单元回归与真实宿主分发分别验收，不以正常 CLI 退出代表会话已持久化。

`cli.stream`另以公开协议5提供一轮实时CLI调用，Open输入沿用project_id/prompt/可选thread_id。提示词一次交付后关闭工具stdin；额外Input拒绝，EOF不取消已提交轮次，取消和到期沿原上下文。协议stdout字节为`format_version:1`的UTF-8 JSONL，可跨公开Output分片；只保留线程、轮次、条目类型/状态及正文，不转发原命令、任意工具输出、失败详情、未知字段或stderr。部署环境值在完整行正文中脱敏，先收到turn.completed不表示公开成功。

实时线程收到有效UUID后先登记uncertain与零轮次；恢复启动前写uncertain。直接工具零退出、完整回答、公开终态体积检查与持久提交全部成立才计轮次。最终结果返回text/project_id/thread_id/十进制turns、stream_format_version及resource_scope:direct_process，不返回原events；文件锁与工具后台共享所有权，丢弃Future不能把尚未退出的进程或阻塞工作计为已清理。五秒/512KiB首帧分派继续接受原协议4五操作。

当前为CLI与持久会话实现及实时输出生产改动，实际门禁按所属裁定登记；SDK会话、运行环境准备及原测试助手工具业务仍需继续迁移，不能以CLI调用代替完整助手。旧窗口、主题快照和目录选择交由后续浏览器设计，不迁移Electron窗口。
