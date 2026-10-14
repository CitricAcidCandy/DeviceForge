# AI 助手业务用例

## 当前目录结构

2026-10-14按用户最新约束采用 Ant Design Pro 风格的功能组织。此前 domain/application/infrastructure/ui 方案已被覆盖，不再作为当前目录约束。根 `index.ts` 保留核心公开API且不加载TSX，目录仅按实际职责创建。

- `models/`：用例、状态、订阅、轮询与会话控制；HTTP工厂在此组合注入的服务。
- `services/`：网关、归档IO、字节解码与浏览器适配，不反向引用models。
- `utils/`：纯规则、转换、结果验证和计算，不依赖models、services或components。
- `types/`：业务模型与端口类型；保留已有共享契约类型。

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
