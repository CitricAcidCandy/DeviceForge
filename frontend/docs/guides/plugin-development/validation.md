# 浏览器插件调试、验证与交付

## 本机 Debugger：公开合同与验证边界

兼容的 DeviceForge 产品默认随附官方调试器。使用者正常启动宿主并在本机以回环地址打开界面，点击悬浮球选择目标即可；无需额外导入 Debugger 包或选择验收专用程序。资源市场「已安装」可停用和重新启用；已有同名独立安装仍由原安装入口管理。市场／MCP 的本地导入用于被调试插件，或显式替换随附调试器版本。旧宿主缺能力时先升级宿主，不把空结果当作调试成功。

使用部署者提供的兼容 localhost 宿主及其实际 MCP 地址，不需要宿主源码或内部构建脚本。调试协议 1 要求真实回环连接及允许的本机浏览器来源。先查询实际能力；缺少公共服务时明确提示升级。当前实现与正式联调证据分开，`production_acceptance_complete=false` 保持不变。

浏览器公共服务为 `context.extensions.callService('host.debugger','1',request,signal)`，返回原 `HostResult` 的 `data/logId`，需要先判断可选 `context.extensions`：

| request.action | 公开参数与用途 |
| --- | --- |
| `capabilities` / `status` | 能力与当前桥状态，不启动变更 |
| `start` | 显式启动当前浏览器桥 |
| `reconnect` | `input:{confirmed:true}`；结束旧实例会话，不重放动作 |
| `call` | `name` 为公开 `deviceforge.debug_*` 工具名，`input` 为其 JSON 参数 |
| `installation` | 当前安装构建目录；宿主缺接线时明确不可用 |
| `logs` | `input:{log_id?,q?,order?}` 简单搜索，不接收诊断流游标 |
| `focus` | `input:{target_kind,plugin_id}` 或明确 `candidates`；须已启用官方面板 |

1. 通过原市场本地导入或原 MCP 安装流程安装插件，不另建 Debugger 上传、安装或发布入口。普通 DOM 可观察不表示可嵌入；`developer.tools` 仅追加，`devices.apps` 是整个区域。
2. 调用 `deviceforge.debug_targets`，明确选择真实浏览器 `instance_id/plugin_id/generation`，以 `debug_session` 的 `action=open,target` 打开会话。不要默认选择第一个实例。
3. `debug_inspect` 读取本代贡献与挂载根，`debug_ui_tree` 多根时显式指定 `root_id`。未实例化页面不会自动打开；每页最多 500 节点、响应有 1 MiB 限制，每根保留最近 10 个逻辑快照。`debug_ui_query/debug_ui_diff/debug_ui_assert` 分别进行查询、快照比较和三态断言，不完整覆盖不能证明不存在或实际可见。
4. 浏览器 `debug_invoke` 的 `parameters` 指定 `kind=command/service,id,input,confirmed=true,allow_unknown_side_effects=true`，服务另需精确 `version`。`include_result` 可选且默认 `false`，缺省不复制或遍历返回载荷，仅返回结果元数据；需要脱敏 JSON 时显式传 `true`。服务器 `kind=operation/service` 返回原 Job，不接受 `include_result`。浏览器命令回执仅 `state=succeeded` 才可使用 `response`，未知回执不重放。
5. `debug_ui_action` 保留原禁用、隐藏、表单校验、目标归属和副作用确认；点击已派发不等于业务成功。缺少实际导航白名单时拒绝导航。
6. `debug_reload` 使用 `parameters:{confirmed:true}` 重载明确目标，默认 `follow=false`。旧会话进入 `target_changed` 后，重新查询真实目标，以 `debug_session` 的 `action=select,session_id,target` 显式选择新代，或重新打开会话。不能沿用旧代节点、自动重放，也不能据此认定其他标签页已更新。
7. 最后以 `debug_session` 的 `action=close` 关闭自己的会话；闲置 30 分钟过期，不影响其他调用者。取消等待、断线与回执丢失不证明服务器未接受动作，先查询实际状态。

`deviceforge.debug_events` 分两种来源：`source=lifecycle` 为有界会话／命令事件，支持 `session_id/after/limit`，省略 `source` 的旧调用仍兼容；`source=logs` 是真实服务器持久日志查询，必须指定 `plugin_id`，可带 `generation/log_id/job_id/session_id/q/order/cursor/limit`，页大小 1–100。返回 `entries/next_cursor/limited/coverage`；服务端先筛选排序再分页，不在最近 200 个事件上伪造全范围搜索。日志查询端口与真实分页已实现，当前集成源码已有 HTTP/MCP 适配器注入；实际发行版与端到端结果仍须核实。无端口返回 `debugger_diagnostics_unavailable`，游标过期明确重新查询首页，不能把生命周期 `after` 当成日志游标。

`deviceforge.debug_report` 使用 `{session_id,parameters:{export:'none'}}`，`export` 支持 `none/json/markdown`，默认 `none`。返回 `{report,artifact}`，不导出时 `artifact=null`；显式导出写入原产物存储，返回产物元数据和下载 URL。缺产物存储、目标换代或结果未确认时明确失败，不自动重复导出。浏览器报告的 `snapshot_manifest/continuation` 位于报告 `evidence` 中，冻结快照续页调用 **`deviceforge.debug_ui_tree`**，参数为 `root_id/snapshot_id/offset/limit`；沿 `tree.page.nextOffset` 继续同一快照，不能将续页参数交给 `debug_report` 或重新采集变化中的 DOM。过期快照须显式重采。

插件可选使用 `context.debug.registerNode` 登记语义节点，使用其返回句柄的 `update/dispose` 更新或撤销；通过 `context.debug.emit` 发事件，以及 `context.debug.registerResource(definition,release)` 登记资源。缺能力时普通功能及 `context.onDispose` 清理仍须工作。每次挂载各自登记，撤销释放本作用域资源，只接受有界 JSON 元数据，不读取任意 Props、输入或 React 私有状态。字段脱敏不能识别自由文本的所有秘密。独立工程的单元测试和打包成功不等于官方面板、实际安装、真实浏览器或完整生产闭环通过。

调试工具创建并取得自己的会话标识后，可用 `context.debug?.registerSession?.(sessionId)` 登记其生命周期归属。返回的释放函数会关闭该会话，不是仅解除登记；显式关闭后也应调用以回收登记，重复关闭幂等。每插件最多64项活动登记，ID最多128字符。宿主在挂载／功能子作用域或插件卸载时独立、有界地关闭已登记会话，不复用已经撤销的插件调用入口，不关闭未登记的 MCP 会话。旧宿主缺能力时需提示自动回收不完整，失联或未获知会话ID时不得宣称已释放。

验证对象应是将要上传的实际归档、当前宿主版本和目标环境。已有示例或历史门禁证明其对应版本，第三方改写的插件不能继承通过结论。下面是开发者复验步骤；执行并记录真实结果后才可声称通过。

## 调试流程

1. 在自己的工程完成入口语法、类型和相关单元检查，核对实际归档，再上传到部署者提供的调试宿主并启用。先确认插件身份、版本、入口与当前实例状态，挂载失败时查看自有模块的浏览器控制台错误和网络请求。
2. 使用 `context.listOperations` 和可选服务目录确认公开能力及真实输入 Schema。目录缺少操作、服务或公共 ESM 导出时，分别判断提供者未启用、依赖或配置缺失、版本不兼容，不猜测私有接口。
3. 用最小已知输入显式提交任务，保存 Job ID 与 `logId`，通过 `context.getJob` 查询终态后核对结果；把提交失败、查询失败与任务失败分开显示。未收到响应时不能编造日志 ID，也不自动重复有副作用的提交。
4. 通过 `AbortSignal` 取消本地等待，确认关闭或换代后的晚到结果不写入当前界面。要停止服务器任务时调用 `context.cancelJob` 并查询终态，不能把关闭面板当成任务已停止。
5. 检查挂载、停用、重载后的 DOM、监听、订阅和服务撤销，以及当前选择的设备、实际产物字节和日志关联。保留自己的包版本与复现步骤，接口详情继续通过 MCP 的 `sdk`、`lifecycle` 和 `examples` 主题取得。

## 静态与归档

- 核对 `package.json`、`plugin.json`、默认导出的 ID、版本、SDK 版本一致。
- 原生 ESM 入口执行 `node --check`，TypeScript/React 工程另执行自己的类型检查与构建。
- 核对实际 ZIP/TGZ 包含清单、入口、相对依赖及资源，不含凭据或包外路径。
- 检查贡献 ID 命名空间、模块路由、服务精确版本、实际槽位和可选能力判断。
- 检查每个异步 SDK 调用均有显式 signal，每个挂载返回清理函数，所有自有资源均可释放。

语法正确只证明可解析；Node 导入也不能替代浏览器模块加载和界面验收。没有实际上传、启用和调用时，应明确写“静态核对通过，运行未验证”。

## 当前宿主真实行为

| 场景 | 预期与需保留证据 |
| --- | --- |
| 上传并启用 | 已安装身份与入口正确，无刷新宿主即可激活，错误能显示 |
| 操作发现 | 可读取真实目录及输入模式，保留响应日志 ID |
| 面板/模块/组件 | 正确挂载到宿主容器；具名槽位缺失有明确失败；route 不冒充导航接入 |
| 命令/服务 | 能按 ID/精确版本调用；缺失与卸载后返回不可用 |
| 任务提交 | 使用明确的测试操作和输入，记录任务 ID、日志 ID，查询到真实终态 |
| 取消与晚到 | 关闭面板、取消等待、停用后旧结果不更新当前视图；服务器取消单独验证 |
| 失败回滚 | 激活或 mount 失败后撤销已登记内容，释放错误可见 |
| 重载 | 新代生效，相对模块没有复用旧代业务状态，旧引用失效 |
| 停用/删除 | 当前实例 DOM/订阅/命令/主题已收敛；确认实际目录状态 |

如提供主题、组件 replace 或提交钩子，要分别检查显式选择和撤销、默认内容恢复、真实提交参数变换及抛错中止；只登记成功不证明宿主已经消费。不要用任意真实写操作充当无害测试，应选择授权的设备、输入和结果校验方式。

## 可选能力专项

设备插件要检查精确能力版本、读写准入、断线/提供者移除、刷新换代和设备选择切换。离散调用通过不等于常驻连接、热拔插或真机成功。产物须核对元数据、实际下载字节和所需格式；文件生成不等于成片或内容验收。历史查询核对任务关联、Unix 毫秒、after 游标和取消后不推进消费位置。

宿主服务存在只证明入口装配；性能和 AI 请求仍依赖实际后端插件、工具链、项目配置或设备。需分别验证服务目录、真实调用、失败日志、取消和结果，不把模拟数据或 runtime.status 当作全部业务成功。

## 工程与交付边界

在自己的独立插件工程执行相关单元测试、类型检查和打包检查，无需获取宿主源码或运行宿主生成器、构建及整套回归。通过部署者提供的兼容宿主验证实际上传、启用、挂载、调用和清理；使用公开 SDK 与公共 ESM 入口，不导入宿主私有模块。分别记录独立工程检查和实际运行结果。

交付记录至少包含：包版本及摘要、宿主/SDK 版本、安装与启用结果、实际操作/任务/日志 ID、终态与输出、取消和卸载结果、浏览器及设备环境、未验证项。敏感凭据和业务数据不进入记录。区分静态、编译、实际通信、生命周期、具体产品界面、视觉、真机与容量证据；只报告实际完成的层次。

## 完整功能发布复验

网页先探测 `/api/v1/capabilities`，用缺接口、错误版本及失败响应确认明确提示升级且没有 POST 资源。分别验证 CORS、HEAD 长度和 ETag，SHA-256 与真实上传字节一致。缺组件、缺工具、错误清单、错误 marker 和同版本替换时不出现新 catalog 条目；已上传资源可以保留，不把它描述成回滚失败或发布成功。

在线发布顺序为组件/工具、在线清单、catalog；离线 ZIP 根包含 release.json 和全部 blobs。更改在线 path 后重新计算清单摘要，不能混用离线修订。两种来源都测试真实安装任务终态、缺必填配置、配置保存后启用、重启保持意图与当前浏览器激活状态。敏感遮蔽文本不能当原值资格，高级工具路径不能泄漏到浏览器结果。

更新/启停/卸载验证 expected_revision 冲突、本次真实清理失败、两端配置保留、共享工具引用保护；另外验证历史告警不阻断独立新操作或真实排空后的重载，恢复中仍能使用无关业务，且旧诊断可查看。纯组件失败可重试，真实文件事务异常只约束对应发布的文件变更；加载/激活/挂载/清理回调永不返回时，取消或到期后队列仍能处理新操作。生命周期的公开规则继续查询本指南 `lifecycle` 主题。旧独立组件入口继续兼容，同时拒绝拆装统一发布所属组件；独立包测试不能替代完整闭包、真实网页发布、离线和正式分发验收。该指南描述契约与复验步骤，本身不构成这些页面已经通过的证据。
