# AI SDK 普通任务基础消费

## 当前目录结构

2026-10-14按用户最新约束采用 Ant Design Pro 风格的功能组织。此前 domain/application/infrastructure/ui 方案已被覆盖，不再作为当前目录约束。根 `index.ts` 保留核心公开API且不加载TSX，目录仅按实际职责创建。

- `models/`：用例、状态、订阅、轮询与会话控制；HTTP工厂在此组合注入的服务。
- `utils/`：纯规则、转换、结果验证和计算，不依赖models、services或components。
- `types/`：业务模型与端口类型；保留已有共享契约类型。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| types.ts | 六项普通操作、输入、结果和目录观察类型。 |
| rules.ts | 项目、Unicode、提示词字符限额、UUID规范化及冻结副本。 |
| results.ts | 固定提供者/版本/档案、归属、轮次、状态与空产物封套校验。 |
| catalog.ts | 动态公开目录、刷新代际、入口撤销和晚结果隔离。 |
| index.ts | HTTP工厂、任务提交、原票据恢复、查询、显式取消与实例销毁。 |

## 输入与结果

普通贡献为 `runtime.status`、`sdk.single`、`sdk.turn`、`session.get`、`session.close` 和 `assistant.run`，完整 ID 均加 `plugin.ai-sdk.` 前缀。新提交必须先通过 `refreshOperations` 发现完整贡献；目录刷新开始即撤销旧入口，失败、取消、替换或销毁不能让晚结果复活。注入 `createAiSdk` 的普通任务网关也须提供 `options.operations` 并显式刷新后才能新提交；历史任务恢复、查询和取消可在未配置目录或贡献失效时使用。

项目 ID 为 1–80 个 ASCII 字母、数字、下划线或短横线；提示词非空、最多 131072 个 Unicode 标量字符，空白判定沿 Rust，孤立代理项拒绝。线程 ID 为严格 UUID 并统一小写。单次不接收线程字段；恢复轮次可省略线程创建新线程。助手只接项目、可选提示词及 `stream_output` 布尔，不接受线程、模型、环境、服务器路径或工具选择；省略的业务选项不由前端填入请求。

成功结果固定 `provider:codex_sdk`、`sdk_version:0.162.1` 和 `resource_scope:sdk_worker_proxy_and_cli`，资格结果另核对 `profile:codex_sdk_ts_0_162_1_node24`。项目和既有线程逐项核对，线程回显必须已为小写 UUID；最终正文为有效非空 Unicode，最多 512 KiB UTF-8 字节。轮次使用规范十进制 u64 字符串，避免 JavaScript 精度损失。新线程成功为一轮；助手始终新线程，成功轮次与 `assistant_turns` 相等且为 1–4，`stream_output:true` 时为一轮。全部普通结果要求空产物封套，字段之外的路径、诊断或资源声明均拒绝。

状态的配置、模块加载、进程资格、模型验收和 `ready` 各自保留真实观察；实际 Node/CLI 版本不合格时可以原值返回。前端校验字段和固定身份，不重新计算后端资格或 `ready`。`ready` 不证明认证、模型可用或进程树已经释放。查询保留 `closed` 与 `uncertain`；关闭仅确认本地恢复资格关闭，不推导提供者历史已删除。是否可开始新的线程轮次由后端资格/锁规则裁定，前端不接管 CLI 历史、不消除不确定标志，也不自动重试。

## 任务与取消

`single`、`turn`、`getThread`、`closeThread` 和 `runAssistant` 提交实际普通任务；对应 `resume*` 方法只恢复原 Job 等待，不再次提交提示词或关闭操作。任务 ID、提供者线程 ID 和协议5会话 ID 各有职责，不能互换；票据只允许六项普通贡献，冻结复制后校验原任务身份和操作。任务及失败日志沿共享执行器保留，取消等待不自动调用服务器 cancel，不回退到另一提供者或助手补轮。

`dispose` 结束本实例目录和任务等待，消费忽略信号的晚到成功/拒绝；它不自动关闭线程，不证明服务器资源树或模型工具已释放。普通六方法已接入通用 HTTP 操作与任务入口。普通 `assistant.run.stream_output:true` 仍消费普通 Job 最终结果。公开实时 JSONL 只属于独立 `sdk.stream` 协议5贡献，已由[SDK 实时消费模块](../ai-sdk-streaming/README.md)实现，并装配宿主服务 `host.ai-sdk.stream`，浏览器插件通过公开 `extensions.callService` 消费。

运行时同时装配版本为 `1` 的 `host.ai-sdk` 服务。插件通过 `extensions.callService('host.ai-sdk', '1', request, signal)` 调用普通六项动作：`runtime.status` 只需 `{ action }`，其余动作使用 `{ action, input }`；宿主首次调用时按当前公开目录刷新 SDK 贡献。服务等待任务终态，只返回已校验的公开业务结果并保留最终 HTTP 日志 ID，不返回内部 Job、服务器路径、令牌或中间诊断。输入字段、项目/线程归属和结果版本仍按本模块合同校验，插件卸载或运行时销毁会撤销在途调用。

目录中的通用 `execution.api_version` 表示执行预算元数据版本，当前为 `1`，不等于 SDK 实时会话协议版本；协议5以独立贡献合同为准。

## 验证边界

`ai-sdk-consumption.test.ts` 使用真实 HTTP 客户端与受控传输、注入任务网关验证输入、公开结果、目录竞态、取消恢复、日志和销毁。本批完整前端 `npm test` 已通过 53 个文件、511 条用例；`npm run check` 已通过 165 个源码的架构检查及 Svelte、严格 TypeScript 检查，`npm run build` 已通过 175 个模块的生产构建。

这些门禁不能计为实际官方 SDK、真实模型、当前后端宿主服务、浏览器产品界面或资源树退出验收。真实 SDK 宿主服务与模型仍待独立验收，产品 UI 继续等待设计稿。后端私有官方 SDK 加合成 CLI 的证据继续独立记录，不转写为本模块已取得真实 SDK/模型联调。
