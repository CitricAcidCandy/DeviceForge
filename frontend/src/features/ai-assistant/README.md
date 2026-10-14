# AI 助手业务用例

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。
- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。
- `infrastructure/`：宿主网关、字节流解码、媒体与浏览器适配；依赖纯规则和模型。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

`createAiAssistant` 通过真实任务消费 `plugin.ai-assistant.runtime.status/cli.single/cli.turn`。`rules.ts` 校验公开项目 ID、131072 字节提示词上限和规范 UUID 线程；`results.ts` 校验项目、线程、原始 JSON 事件、回答及完成事件，拒绝部分回答或失败事件；`index.ts` 负责运行、原任务恢复和显式取消。

`session.get/session.close` 管理本插件已登记的会话，保留规范十进制轮数、`closed` 和 `uncertain`。关闭只撤销本地恢复资格，不代表删除提供者历史；不确定轮次不可自动重放。读取和关闭仍等待真实任务终态，并可查询恢复管理操作，不能用当前目录推断旧会话状态。

创建入口是首次 `turn({project_id,prompt}, signal)`：不携带 `thread_id`，对应正式 `cli.turn`，后端完成首次 CLI 轮次后持久登记真实线程归属。后续轮次带该线程 ID；`single` 是不携带已有线程的单次调用。正式 manifest 没有独立 `session.create`，前端不新增或映射这个操作。`query` 读取真实 Job 状态，`resumeTurn` 只恢复原任务查询，不重新提交提示词；会话 `get/close` 和任务查询是两类不同操作。

提示词保持原文本，项目工作目录、CLI 程序和环境配置由后端部署映射，前端不提交本机路径。单次请求不允许携带已有线程；UUID 输入和返回统一为小写，轮次消费服务器真实非空线程身份，事件内部出现线程开始标识时必须与返回线程一致。结果保留事件与任务日志，不在文档或诊断中记录提示词内容。

当前只实现后台任务型 CLI 单次与轮次消费；实时流、SDK 提供者、会话工作台、具体页面和真实模型运行没有以此模块替代验收。

## 已知任务的状态与事件观测

`createAiTaskObserver(gateway)` 接受已有 `JobTicket`，通过 `select(ticket, {after?}, signal)` 分别读取真实 Job 和持久任务事件，提供 `snapshot/subscribe/dispose`。票据来自既有任务提交或 `JobWaitFailure` 的原任务身份；观测器不创建任务、不提交提示词、不恢复模型轮次，也不自动取消服务端任务。显式服务端取消仍使用已有 `createAiAssistant.cancel`，随后重新选择原票据读取实际终态。

`task-observer.ts` 负责只读编排、可取消等待、选择代际和订阅生命周期；`task-event-rules.ts` 只校验五个正式 AI 操作的票据、游标、事件关联与整数范围；`task-observer-http.ts` 的 `createHttpAiTaskGateway(client)` 复用既有生成任务端点和 `/api/v2/jobs/{id}/events`。生成 DTO、共享任务网关、公开 SDK 和其他 feature 不增加新字段或内部依赖。

观测结果保留 `ticket/job/events/after/jobLogId/eventsLogId`。`after` 是本批最后序号，空批保留原游标；每次 `events` 仅表示本批增量，不自动拼成完整历史。输入游标必须为非负安全整数，返回序号须严格大于游标且逐项递增；允许序号间隙和非单调时间，拒绝错 Job、重复或倒序序号、不安全整数及非法状态。接受后复制票据、任务字段和事件并冻结外层对象，保持真实业务结果和提交日志，不推断线程归属或远端清理。

Job 与事件属于两次 HTTP 响应，观测保留不同 `jobLogId/eventsLogId`；顶层 `logId` 对应最后事件响应。状态和事件不是原子事务，事件中出现成功不改写同时读取到的 Job 状态，事件也不包含实时模型 token。任务查询失败保留实际任务日志，事件失败保留实际事件错误；事件等待取消在没有事件响应时保留已取得的任务查询日志。

切换选择撤销旧请求并隐藏其他任务的旧结果；同一任务刷新可暂时保留已接受的上一批观测。调用者取消、切换或销毁均立即结束等待，即使注入网关忽略信号或永不返回；晚到成功和拒绝不会覆盖新任务或复活已销毁的订阅。已接受的观测属于此前读取事实，取消等待不证明服务器 Job 被取消或模型副作用停止。

2026-10-12 定点验证：新增观测14项与既有AI消费/旧单次转换32项合计46/46通过；`tsc --noEmit`退出0，架构门禁115个维护源码通过。先行测试在观测入口缺失时失败，新增实现后通过。本轮尚未运行API生成、全前端测试/构建、真实Rust服务、浏览器或模型；生成和共享构建由主代理串行接续。

## 旧 CLI 单次请求纯转换

`convertLegacyAiSingleRequest(value, options)` 只把未知输入中的旧 `projectRoot/userPrompt` 转为现有 `AiSingleInput`，不提交任务、不查询服务、不读取目录或配置、不修改输入。旧字段依据旧工程 `src/main/ipc_handler/case_assistant/types.ts` 的 `CaseAssistantCliSingleRequest`，不是新后端部署配置的导入格式。

调用者必须提供 `AiLegacySingleOptions.projectBindings`，将旧目录文本显式绑定到后端已部署的公开项目 ID。键按原字符串逐字匹配，不裁剪、改大小写、统一分隔符、移除尾分隔符、解析相对路径或推断目录别名；需要别名时由调用者分别提供绑定。仅匹配自有键，不消费原型链上的绑定；所有绑定均须满足现有公开项目 ID 规则。转换只证明输入与显式绑定合法，不证明项目已部署或模型可用。

```ts
import { convertLegacyAiSingleRequest } from './index.ts';

const input = convertLegacyAiSingleRequest(
  { projectRoot: 'C:\\项目\\示例', userPrompt: ' 请保留原始文本\n' },
  { projectBindings: { 'C:\\项目\\示例': 'demo' } },
);
```

输出只含 `project_id/prompt`；提示词保留原文，非空和 UTF-8 上限复用 `rules.ts` 的公开单次输入规则，不另设迁移限额。目录未绑定、字段缺失、非 JSON 数据、未知字段或无效绑定均拒绝。`timeoutMs/requestId` 没有等价公开字段，只要作为自有字段出现便拒绝，包括 `null/undefined`，不能静默丢弃或误当任务期限、日志 ID。

SDK、持续流、旧会话身份、凭据、程序路径、环境和部署配置均不在转换范围；不得将这些字段作为转换选项或旧请求输入。错误使用中文固定消息，不回显目录或提示词内容，不伪造日志 ID。调用者后续是否显式调用 `single` 仍由现有任务用例负责，与本转换分离。

定点用例位于 `frontend/tests/ai-assistant-legacy.test.ts`，覆盖显式绑定、原文保留、非法输入、无等价字段、UTF-8 边界、无输入修改及无任务调用。2026-10-12 主代理终验为定点23/23、严格检查106源码、完整291/291、API生成及161模块构建通过；公开任务用例提交组合取消信号，测试验证状态及调用者取消传播，不要求与原信号对象相同。首次定点误断言和与 npm ci 重叠的依赖缺失失败原件均保留，最终串行复验通过。这些证据不代表真实模型、SDK、持续流或产品UI已验收。
