# SDK 实时会话基础消费

本模块独立消费协议 5 的 `plugin.ai-sdk.sdk.stream`，通过现有生成类型与 `SessionGateway` 获取目录、打开会话、恢复、读取输出及显式取消。`createAiSdkStreaming` 接受注入网关，`createHttpAiSdkStreaming` 接受公开 HTTP 客户端；运行时已装配宿主服务 `host.ai-sdk.stream`，浏览器插件通过公开 `extensions.callService` 消费。模块没有产品界面或公开插件 SDK 的新增字段。

## 入口与恢复

新提交须先显式调用 `refreshDefinitions(signal)`，目录包含精确贡献后才能 `open({project_id,prompt,thread_id?}, signal)`。目录刷新开始撤销旧目录，刷新失败不能继续用旧目录提交。普通 SDK Job、助手及 CLI 实时贡献不会作为此入口。

公开目录没有会话协议版本字段；通用 `execution.api_version` 表示执行预算元数据版本，当前为 `1`，不等于协议5。前端以精确贡献和公开合同消费实时会话，后端运行资格由普通 SDK 状态原样观察，前端不重新计算 `ready`、进程范围资格或模型验收状态。

提示词仅在 Open 中交付一次，没有额外 Input、EOF、自动重提或自动服务器取消。Open 等待失联后通过 `refreshRecords` 找到实际会话，再显式 `resume(sessionId, owner, signal)`；`owner` 指定项目与可选 SDK 线程。协议 Session UUID 与 SDK 线程 UUID 分别保留。

同实例恢复同 ID 保留游标及已完成的事件，拒绝更换项目或已观测线程；新实例从零重建公开输出。读取和轮询携带真实游标与 1—100 的页长。每页先校验会话身份、代次、创建时间、序号和全部 JSONL，再原子发布，错误页面不局部推进游标。

## 解码与终态

逐字节处理 UTF-8、跨片段 JSON 行与 CRLF，拒绝非法编码、额外事件字段、工具正文、错误身份、重复终态和完成后更新。每次 SDK 流都须出现一次 `thread.started`，恢复线程同样必须出现，且先于 `turn.started`。条目首次可开始、更新或完成，首次公开的稳定别名依次为 `item_1`、`item_2`；更新替换完整快照，完成回答按完成顺序以换行合并。

单片最多 8192 字节，单行含换行最多 512 KiB，全部公开流最多 4 MiB，回答最多 512 KiB。仅接受六类精确事件、七类条目和三个可选状态。脱敏由后端负责，前端不猜测部署秘密，也不将未知原始诊断写入错误信息。

`turn.completed` 是已观察的流事件，成功还要求协议会话 `finished`、全部输出已读、资源清理 `complete`、进程退出确认、无公开失败或产物，以及精确七字段结果与项目、线程、回答一致。结果固定 `provider=codex_sdk`、`sdk_version=0.162.1`、`resource_scope=sdk_worker_proxy_and_cli`；轮次为非零规范 u64 字符串，新线程 Open 必须为 `1`。从历史 Session 恢复时不猜原线程轮次。

失败终态保留 Session 清理证据与原始输出分片，未完成残行可以清除，成功终态拒绝残行。显式 `cancel` 只观察服务器停止/终态；调用方取消、`clear`、`dispose` 只结束当前等待并隔离晚到结果，不证明后端副作用或资源已退出。错误、取消与每类请求日志分别保留；订阅异常隔离，订阅重入不能重新发布旧选择。

## 验证边界

独立测试覆盖真实 HTTP 客户端的受控传输、协议解码、动态目录、恢复游标、归属、资源清理结果、取消和晚到结果；运行时测试覆盖宿主服务装配及实际加载消费者插件调用。本批完整前端 `npm test` 已通过 53 个文件、511 条用例；`npm run check` 已通过 165 个源码的架构检查及 Svelte、严格 TypeScript 检查，`npm run build` 已通过 175 个模块的生产构建。

这些门禁不代表真实 SDK 宿主服务、SDK 模型、完整操作系统资源树、浏览器交互或正式分发已验收；真实服务与模型继续由集成角色独立验收，产品 UI 等待设计稿。
