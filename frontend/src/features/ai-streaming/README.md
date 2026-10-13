# AI 实时 CLI 输出基础消费

本模块只消费公开 `plugin.ai-assistant.cli.stream` 会话贡献。HTTP 通信复用 `shared/api/session-gateway` 的生成类型及端点，不依赖其他功能内部实现，也不增加产品界面、SDK、助手工具或服务器业务分支。

## 公开用例

- `createAiStreaming(gateway, options)` 用于注入公开会话传输；`createHttpAiStreaming(client, options)` 通过真实 API 客户端装配。
- `refreshDefinitions(signal)` 获取真实贡献目录，开始刷新即撤销旧目录；新 Open 必须先发现实际操作。目录是一次观测，不能当作服务器代际租约。
- `refreshRecords(signal)` 获取宿主保留记录，筛选本操作。Open 响应失联时只能由调用者显式定位记录后恢复，不能猜测会话 ID 或自动再次提交。
- `open({project_id,prompt,thread_id?}, signal)` 一次提交一轮提示词。项目标识使用 1 至 80 位 ASCII 字母、数字、下划线或连字符；提示词沿 Rust Unicode 标量和空白规则，最多 131072 个字符；可选线程必须为规范 UUID，显式 null 拒绝。
- `resume(sessionId, {project_id,thread_id?}, signal)` 只恢复传输观测，不重新 Open，不发送提示词。相同实例的相同会话保留解析状态与游标；其他会话从保留输出的序号 0 开始重建。调用者必须给出预期项目，可选线程进一步约束事件及最终结果。
- `query(signal)` 查询所选会话；`readOutput({limit?}, signal)` 消费一页；`pollOutput({limit?}, signal)` 耗尽现有输出后定时等待，直到宿主成功终态或明确失败。页长为 1 至 100，默认 50；轮询间隔默认 250 毫秒，可配置 0 至 60000 毫秒。
- `cancel(signal)` 才向宿主显式发停止请求。取消等待、切换、`clear()` 和 `dispose()` 只撤销本地消费，不自动停止服务器轮次；销毁会撤销定时器、等待和订阅，传输忽略信号时仍及时结束客户端等待。
- `snapshot()` 与 `subscribe()` 发布不可变观测，包括真实会话、归属、原字节、事件、条目、正文、业务结果、独立请求日志 ID 与错误。

本模块不提供追加 Input；后端提示词已在 Open 发送一次。下一轮使用业务线程 UUID 显式重新 Open。传输 `session.id` 与 AI `thread_id` 始终分开。EOF 的服务器行为由通用会话传输负责，本模块不将其当作模型完成。

## 原字节与规范事件

输出页严格检查会话 ID、操作、插件、代际、创建时间和排他游标；页内序号连续，next_sequence 与实际块数相符。保留每块原字节与真实 sequence，不重编号。不接受此操作不应发布的 stderr。

先按原字节拼完整行，再使用严格 UTF-8 解码和 JSON 解析，兼容跨块多字节、跨块 CRLF 与同块多行。每行含换行最多 512KiB，累计规范流最多 4MiB，宿主输出最多 65536 块，事件最多 10000。成功时残行必须为空；明确失败时可丢弃解析残行，同时保留原字节。整页解析在副本中进行，坏行不会局部发布该页先前的有效事件。

每行 `format_version:1`，只接受 thread.started、turn.started、item.started/updated/completed 与 turn.completed，并拒绝额外字段。条目只接受七类公开类型、三个公开状态和调用内稳定的 item_N 别名；仅 agent_message/reasoning 可带 text。item.updated 是完整条目快照，替换条目展示值，不拼接为正文增量。已完成条目不能再次更新或改变类别；轮次完成前所有已观测条目必须完成。

事件携带所属行起始块的 firstSequence 与结束块的 sequence。两行可拥有相同结束块序号，这些值是传输证据，不是业务事件编号。历史重建只重建快照，不重发输入或发布额外事件回调。

## 终态与错误

turn.completed 只记录提供者完成观测。只有公开 SessionInfo 为 Finished、保留输出全部消费、cleanup 为 complete、process_exited 为 true、无公开 failure/error/产物，并通过精确结果校验，才发布成功 result。

最终业务结果只包含 project_id、thread_id、text、十进制正轮次 turns、stream_format_version:1、provider:codex_cli 与 resource_scope:direct_process。项目、线程和最终正文必须与请求及规范事件完全一致，正文和回答累计最多 512KiB；不得把原始事件、命令、工具输出、配置或诊断添加到结果。传输归属不能从 thread_id 推导。项目归属最终由成功结果核验，恢复查询本身不包含项目字段。

观察状态单调合并，并发取消后的晚到 Running 页不能回退 Stopping/Finished，终态结果与输出数量不得漂移。请求日志分别保留，错误不拼接原始未知事件或诊断。轮询取消保留最后一次输出日志；忽略信号的晚到成功/拒绝、切换与订阅重入均不能交付旧结果。

直接资源清理只证明公开直接进程范围，不证明派生进程或远端模型活动。前端解析不能证明提供者部署环境已经充分脱敏；该职责与真实模型验收仍属于后端。

## 当前验证范围

本模块定点测试覆盖跨块 UTF-8/CRLF、白名单与敏感字段拒绝、真实序号/代际/线程、整页原子发布、条目快照与顺序、输入边界、终态/清理、取消恢复不重放、失联记录定位、晚到保护、订阅重入和资源限额。HTTP 测试使用真实客户端与端点适配器，底层传输为注入夹具。

本批不包含真实服务、MCP、浏览器、真实 CLI 模型、SDK、助手工具、产品 UI 或正式包运行证据。生成器、完整前端门禁、真实服务与分发由主代理串行集成记录。

2026-10-12 本模块定点 18/18 通过，TypeScript 严格检查退出 0，架构门禁 150 个源码文件退出 0。没有运行生成器或完整构建；真实后端和正式包证据仍需独立补充。
