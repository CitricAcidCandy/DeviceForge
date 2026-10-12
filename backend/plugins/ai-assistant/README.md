# AI 测试助手业务插件

旧 CaseAssistant 的 CLI 单次请求和 CLI 恢复轮次迁入 `plugin.ai-assistant.cli.single/cli.turn`；状态入口为 runtime.status。请求携带已配置 project_id 与 prompt，turn 可使用规范 UUID thread_id。部署者配置工具入口、附加 argv、项目映射及专用 environment；提示词经 stdin 传递，不拼接 shell，不默认复制旧危险 CLI 参数。

执行使用固定期限和现有 Job 取消。JSON 事件必须有 turn.completed 和实际 agent_message，失败事件、缺失完成、非法 UTF-8 都返回失败；结果保留 text、thread_id、events 与 project_id。状态 configured 只说明配置已读，不证明已认证或模型可用。凭据只来自本插件部署配置，不从宿主环境继承，不输出部署配置或 stderr。

会话元数据保存在部署配置的 state_root（默认配置文件旁 ai-state），原生 UUID 统一小写；记录线程、项目及规范目录归属、轮次和关闭状态。文件锁跨插件进程持有到本轮实际退出，恢复未知线程或跨项目线程会失败。轮次启动前持久化 uncertain，取消、工具失败或服务硬终止后不自动重放可能已产生副作用的提示词；session.get 可查询，session.close 在当前轮次退出后关闭本地恢复资格，不删除提供者历史。两个操作输入为 project_id/thread_id，输出 turns 为十进制字符串及 closed/uncertain。

Windows 在原目录及链接检查通过后规范化现存 threads 目录，锁、临时文件和提交目标从同一规范长路径派生。深目录下首次登记、恢复轮次及关闭保持原子替换规则；提交前取消或真实替换失败保留原文件和内存状态，并回收临时文件。长路径单元回归与真实宿主分发分别验收，不以正常 CLI 退出代表会话已持久化。

当前为实际 CLI 与持久会话实现；SDK 会话、实时事件、运行环境准备及原测试助手工具业务仍需继续迁移，不能以 CLI 调用代替完整助手。旧窗口、主题快照和目录选择交由后续浏览器设计，不迁移 Electron 窗口。
