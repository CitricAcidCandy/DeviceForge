# AI SDK 桥接实施裁定

日期：2026年10月12日。模式为架构先行，采用契约先行与行为回归结合。私有生产写集已获主代理批准并并行实施；公共工具能力、Cargo成员、宿主及生成由主代理集成。SDK业务、助手编排与跨平台清理仍属于完整迁移目标。

## 当前实施与结果冻结

后端首批固定官方SDK0.162.1与Node24.14.0的worker、输入/配置、持久线程资格及帧边界已落盘；私有TypeScript构建和实际SDK加载/start/stream加模拟CLI的8项回归通过。SDK入口摘要为`340f42940ffd5c7b31e6e11a159517339c048d30577d88cafeac976cd620f6a4`。主代理已将插件加入第27个workspace成员，修后/格式化首批Rust10项、lib+tests Clippy、fmt与架构退出0，日志为`artifacts/ai-sdk-first-rust-*20261012.txt`。首编译flush类型错误与fmt首失败原件保留；这些证据不包含Rust完整执行链、真实CLI/模型或三平台原生清理。

`public_results.rs`已按实际源码批准：状态为provider、sdk_version、profile、configured、node_version、cli_version、sdk_loaded、process_scope_qualified、model_verified、ready、projects、reason、resource_scope；session.get/close为provider、sdk_version、profile、project_id、thread_id、turns、closed、uncertain、resource_scope。状态和会话结果不公开服务器路径，有限reason不带原始诊断。助手结果沿TurnResult增加assistant_turns和stream_output，assistant_turns为1至4的十进制字符串；stream_output=true仍是普通Job的最终单轮结果。六项普通贡献与协议5的sdk.stream分别注册，普通操作结果均无产物。

前端普通六贡献基础消费7新文件已冻结，11项定点、严格类型、模块架构与编码检查通过，并纳入当前来源295成员/483串行/build阶段快照；默认Node测试异常仍保留。实时SDK事件合同已精确冻结在`plugins/ai-sdk/docs/公开流契约.md`，前端新实时基础消费另批实施。Rust协调器、实际CLI代理执行、原生监督和助手实际四轮仍在实现，不将输入/schema/planner计为完整执行。

已核宿主合作停止窗口为1250毫秒，公共工具cleanup_timeout最多2秒。SDK内部首次故障固定1000毫秒绝对清理点，CLI与Node/代理监督并行共享该点，不重新授权业务或重复追加窗口。真实CLI任意工具后代依赖通用启动前进程归属及scoped所有者公共能力；直接进程退出不证明全树退出。

## 1. 目标、来源与边界

独立`ai-sdk`插件调用真实官方TypeScript SDK，提供单次、恢复轮次、实时事件及旧测试助手编排。复用公开协议4/5、任务取消与插件代际；真实CLI、Node桥、SDK代理和会话锁分别保留退出/释放证据。源码、合成CLI、实际SDK包、模型与跨平台验收分别记录。

| 已读取来源 | 已确认事实 | 迁移裁定 |
| --- | --- | --- |
| 旧`case_assistant/codex-service.ts:83`、`:177`、`:210`、`:325` | 真实SDK子域使用`startThread/runStreamed`；进程内会话Map；普通非流请求最多四轮固定schema；旧超时只让Promise拒绝。 | 重建持久资格和真实取消，不照搬Map或Promise超时。 |
| 旧`case_assistant/index.ts`与`ipc/handle/case_assistant.ts` | 对外SDK会话门面当前还存在CLI交互路径，名字不能证明SDK实际执行。 | 新SDK命名空间明确提供者，不用CLI成功冒充SDK。 |
| 旧`request-service.ts:36`、`response-merge.ts:8` | 助手请求校验项目、组装prompt、调用Codex并合并事件；prompt固定添加`multi-agent-orchestrator`文本。 | 该文本不是已安装工具或技能的证明；助手编排单列公开用例。 |
| 旧`tool_updater/runtime_loader.ts:15`、`:66`、`:74` | 功能准备与模块加载分开；`case-assistant`映射SDK；开发依赖回退只属开发环境。 | 准备复用tool-supply；SDK执行只读取部署映射和合格运行时。 |
| 旧实际SDK包`0.57.0` | Node要求至少18；该版公开TurnOptions没有AbortSignal。 | 不把旧包作为新取消资格。 |
| [官方SDK页面](https://learn.chatgpt.com/docs/codex-sdk)与固定`rust-v0.162.1/sdk/typescript/src/exec.ts` | 官方SDK是服务器端Node库；固定新版支持`signal`和显式`env`；内部spawn CLI，正常穷尽会等待exit，提前结束finally只kill。 | 首个SDK/CLI资格档案固定为`0.162.1`，不能把finally返回当退出证据。 |
| [Node 24.14.0子进程契约](https://nodejs.org/download/release/v24.14.0/docs/api/child_process.html#subprocessunref)与[进程退出契约](https://nodejs.org/download/release/v24.14.0/docs/api/process.html#event-beforeexit) | 子进程默认保留事件循环引用；unref允许父进程独立退出；beforeExit表示循环已空。当前本机Node实际为24.14.0。 | 受控桥禁止强制exit/unref/detached，以真实自然退出建立屏障；具体资格须由OS句柄回归证明。 |

已检查的CaseAssistant调用边界没有向SDK注册一套宿主自定义工具；工具行为来自提供者命令、文件、MCP和搜索item。迁移这些事件及部署配置，不开放浏览器任意shell/工具路径。旧硬编码凭据不迁入；部署密钥只进入真实CLI专用环境，不进入普通日志、协议结果或配置模板。

## 2. 两条路径与推荐

| 路径 | 影响与风险 | 结论 |
| --- | --- | --- |
| Rust只启动Node，SDK自行派生真实CLI | 修改面小，但真实CLI不由Rust直接持有；SDK内部readline单行与stderrChunks缺少本项目限额；强杀Node不能证明CLI退出。 | 不作为完整SDK实现。 |
| 受控SDK桥、私有exec代理、Rust直接工具所有者 | SDK的`codexPathOverride`指向本插件代理；代理通过有界本机IPC请求Rust启动真实CLI；公开工具库保留CLI句柄、限额和原截止点；Node自然退出确认其SDK代理子进程。 | 推荐。先实现自然/合作取消，再补原生强杀监督；各路径单独验收。 |

代理不自行spawn真实CLI，不修改或猴补丁官方SDK。Rust协调器使用固定资格档案核对SDK argv、线程、项目和提示词，再启动部署者配置的真实CLI。SDK代理仅负责stdin/stdout/stderr/退出状态桥接；其回执不能独立证明进程已退出。

## 3. 公开协议与操作

插件ID草案为`ai-sdk`，完整ID使用`plugin.ai-sdk.`前缀，局部操作不增加`@1`。普通任务清单声明协议4；`sessions`另声明协议5。所有调用总业务期限600000毫秒，排队、资格、复制、锁等待、SDK、解析和提交共同消耗原预算。

| 操作 | 严格输入 | 行为与结果 |
| --- | --- | --- |
| `runtime.status` | `{}` | 返回部署/运行时资格、SDK版本、合格项目ID及有限原因；不表示已认证或模型可用。 |
| `sdk.single` | `{project_id,prompt}` | 一个新SDK线程的一轮；拒绝thread_id。 |
| `sdk.turn` | `{project_id,prompt,thread_id?}` | 新线程或已登记SDK线程的一轮。 |
| `session.get`、`session.close` | `{project_id,thread_id}` | 查询/关闭本地恢复资格；关闭不删除提供者历史。 |
| `sdk.stream` | Open为`{project_id,prompt,thread_id?}` | 协议5一轮实时调用；prompt一次交付，额外Input拒绝，EOF不取消已提交轮次。 |
| `assistant.run` | `{project_id,user_prompt?,stream_output?}` | 旧助手prompt编排；流模式一轮，非流模式最多四轮固定schema，四轮共用原期限。 |

项目ID为1至80字节ASCII字母/数字/下划线/短横线；prompt非空且最多131072个字符；thread_id存在时必须为规范UUID字符串，统一小写；拒绝null、未知字段、服务器路径和工具选择。`assistant.run`的可选user_prompt沿同样字符上限，省略时仍保留旧固定前缀；stream_output只接受布尔、省略false。该操作不接受既有thread_id，也不隐式执行另一CLI回退。

单次/恢复成功结果草案为`{provider:"codex_sdk",sdk_version:"0.162.1",project_id,thread_id,text,turns:"十进制字符串",resource_scope:"sdk_worker_proxy_and_cli"}`。查询另返回closed/uncertain。实时Output为`format_version:1`的UTF-8 JSONL，沿现CLI流的线程/轮次/item白名单、稳定条目别名与完整正文快照；Finished才是公开终态。成功须有效回答、完整事件、真实工具零退出、桥屏障、终态大小和原子提交全部成立，不返回原工具事件、命令、任意工具输出或stderr。

`assistant.run`明确保留旧最多四轮的`is_final/final_answer/next_step/missing_info`固定schema；每轮都记录已确认轮次，只在最终非空final_answer时业务成功。解析失败或四轮耗尽返回有限业务错误，已发生的轮次不重放。提供者工具的失败item与turn.failed分别记录有限类别，原诊断不公开；具体是否因失败item中止遵守冻结助手契约，不能静默改变严格模式。

## 4. SDK/CLI线程归属

新SDK元数据包含format_version、provider、sdk_version、project_id、规范project_root、thread_id、turns、closed、uncertain及资格档案。SDK state_root与CLI资格分别管理；无provider的旧CLI记录不能恢复为SDK，反向亦不能静默迁移。底层原生UUID即使相同，也不表示本插件取得归属。跨提供者显式导入/接管须后续独立合同和锁协调，不在本批自动尝试。

首次收到有效thread.started，在真实CLI仍运行时取得跨进程锁，原子登记uncertain与零轮次；已登记线程恢复前写uncertain。只在该轮SDK事件、真实CLI退出、Node/代理退出与持久提交完整确认后清除uncertain并加轮次。未知/关闭/uncertain/跨项目/目录变化/资格不匹配均拒绝恢复，取消、到期和不确定结果不重放。

协议5session_id只标识传输，thread_id只标识提供者历史。文件锁由资源所有者共同持有到实际进程/管道/阻塞工作结束，Future丢弃不提前解锁。所有同步状态文件工作进入一个有界阻塞worker，原子提交前再次检查原取消/截止点。

## 5. 私有桥、实际退出与状态

### 有界传输与准入

每次调用建立仅监听loopback的临时端口及随机关联nonce，Node只取得本次连接信息。nonce是进程内部关联信息，不改变服务默认免鉴权决定。协调器先启动固定包内worker，再接受一次身份匹配的worker握手；SDK实际spawn的固定代理使用另一角色握手，不能用worker连接冒充代理。握手核对协议版本、调用ID、角色、档案及单调序号，连接总数最多2，未握手连接最多2；单帧最多64KiB、待发送队列最多32帧，读写均有界背压，断开不自行重连或重放。

所有握手、排队和读写受原InvocationContext及最多1000毫秒的握手子限额共同控制，取更早截止点。一次调用只允许一个在途SDK代理和一个真实CLI；助手最多四轮顺序准入。代理提交固定SDK档案产生的独立argv及stdin，Rust核对操作、规范项目、thread_id、固定选项、schema路径与原prompt的档案字节变换，禁止任意额外程序、shell字符串或未知参数。所有校验通过才使用公开tool-process启动部署者指定的真实CLI；不通过时返回有限错误并停止该调用。

Rust在SDK分配readline或stderrChunks前限制真实CLI输出：stdout累计4MiB、stderr累计1MiB、原始单行64KiB、最多10000事件，最终回答512KiB。允许的大型回答通过有序分片传入SDK代理，重组仍受同一原始行上限；不得把分片作为绕过单行限制的方法。私有候选结果总量最多768KiB并分片传输；公开Output单行最多512KiB且须另作JSON编码后的大小校验。原始CLI双流不写普通日志、不进入公开响应；只向SDK既定通道交付，实时公开事件经白名单转换。慢接收者、非法帧、超限或顺序错误停止业务并进入同一个固定清理点。

SDK生成的schema临时文件只允许位于该调用的受控临时根；Node的TMP/TEMP与受控SDK档案匹配。Rust核对实际文件、固定助手schema与限额，不接受浏览器路径。部署密钥由Rust只传给真实CLI；Node与代理采用显式最小环境，仅含连接、固定运行时查找与受控选项。SDK原生历史使用独立codex_home，不能与既有CLI默认历史及资格目录混用。

### 自然退出与合作停止

Node worker禁止process.exit、unref和detached；结束业务后关闭控制输入、定时器和监听器，使用process.exitCode并自然退出。用户取消、到期及SDK错误通过AbortController和私有停止控制结束SDK迭代；提前结束generator不能单独证明代理已退出。shutdown状态的beforeExit只发送一次有界最终候选帧，不充当OS退出证明。协作候选可以报告成功、取消或业务失败，但不能自报cleanup_complete。

Rust资源所有者持有Node、真实CLI、IPC、阻塞worker、线程锁及临时目录。公开结果必须同时核对候选身份/阶段、Node实际OS退出、代理实际退出、CLI公开工具所有者返回、IPC与管道关闭、阻塞worker完成以及文件提交资格；Node自然零退出屏障只能用于固定SDK/Node已实证的无unref档案。父端强杀、异常退出或未知SDK版本不得套用自然退出推断，须走第7节原生监督。后台资源任务继续持有锁；调用Future丢弃只触发停止，不释放实际所有权。

| 业务情况 | 必要退出证据 | 业务/资源结论与线程 |
| --- | --- | --- |
| SDK完整成功 | 完整事件、匹配候选、真实CLI零退出、Node/代理实际退出及提交成功 | 成功/清理确认；清uncertain并增加已确认轮次。 |
| 合作取消或到期 | 原业务截止后未启动新CLI；现CLI、Node、代理及worker均已实际结束 | 取消或到期/清理确认；保留uncertain，不重放。 |
| SDK、帧或CLI失败 | 同样完成资源退出与临时清理 | 有限业务失败/清理确认；发生提供者副作用时保留uncertain。 |
| 强杀后退出已由原生监督确认 | 原生成员资格完整、全部实际退出且CLI owner已返回 | 按原业务终态/清理确认；不能提交晚到成功。 |
| 缺成员、缺退出、清理超时或清理失败 | 仍有资源或无法确认 | 清理失败；锁与资源所有权保留，插件代际保持draining，不允许重载。 |

取消不是一律清理失败。清理是否确认取决于实际资源证据，与业务是否成功分别判定。原业务截止后只能发送停止、回收和清理，不能执行新轮、扩大预算或提交晚到成功。Node的运输停止token与用户业务token分开，避免公共执行器立即强杀Node而丢失合作屏障；独立清理运输窗口不重授业务权限。最早故障处只固定一次清理起点，建议内部1000毫秒收口并给宿主响应留余量；当前宿主实际停止窗口须由主代理在生产前核对，不能把SDK默认超时或重新计时当取消实现。

## 6. 环境准备、固定版本与资格

运行时准备使用公开`plugin.tool-supply.runtime_feature.status/prepare`，功能键草案为`ai-sdk`。部署者清单按type=runtime、featureKey=ai-sdk映射Node、SDK依赖完整归档和匹配CLI；准备仍沿现有单快照、逐模块锁、顺序提交与失败部分保留语义。ai-sdk插件不导入tool-supply私有实现，不自行npm install、不在请求中下载或选择版本；前端/调用者先准备，部署配置由受控安装映射生成或部署者明确填写，再查询SDK档案资格。

首个档案`codex_sdk_ts_0_162_1_node24`固定SDK与CLI为0.162.1、Node为24.14.0。SDK的npm元数据要求Node至少18且固定依赖@openai/codex=0.162.1；本档案主动收窄到已检查的Node版本，以便建立实际退出与输出限额资格。npm包integrity为`sha512-oG3u4y8Zq9t5QvlABcGo0cby/E2d6nrYZq71F/JBy2VOsOoqhhaMlbA7/35SWsykYGouL+T+3RgRT2X/xE+Y1g==`，它只标识该npm包，不能替代tool-supply要求的部署ZIP SHA-256、完整依赖与CLI平台包身份。

worker与私有代理为插件固定包内入口，部署配置不能替换它们。配置只选择已登记档案、Node/SDK/真实CLI的部署入口、允许项目映射、SDK资格根、独立codex_home与真实CLI专用环境；未知字段、相对程序路径、错版本、缺入口或混用历史根均拒绝。提供者认证、模型、MCP与工具配置由部署者在专用环境和独立配置根管理，不进入浏览器参数或普通日志。模板中的示例路径、空环境和版本文字不表示程序已安装、已认证或模型可用。

资格按层独立记录：配置可解析；tool-supply托管准备；实际Node与SDK模块加载/版本核对；固定代理与模拟CLI协议/清理；固定真实CLI与真实SDK完整轮次；真实认证/模型/提供者工具；当前宿主HTTP/MCP、浏览器基础用例、正式包与npx；各目标OS原生强杀监督。runtime.status只反映已有证据及有限失败原因，不把前一层提升为后一层。SDK异常不自动切到旧CLI重放prompt，包更新必须建立新档案并重新取得清理资格。

## 7. 原生强杀监督的闭合实施

自然退出只是完整清理的一条路径。首次生产写集同时包含私有原生监督，不能以自然退出测试通过发布一个声称完整取消的SDK插件。监督单元仅拥有本调用的Node、SDK代理及其登记后代；真实CLI继续由Rust协调器的公开tool-process所有者直接持有。CLI内部提供者工具另按真实CLI及目标平台实测记录后代退出证据；直接CLI退出不能扩大为任意后台工具进程已全部退出。无法完整确认时继续清理失败，不能移除该缺口。

原生监督可以采用插件同一可执行文件的私有supervisor入口，启动前固定职责、父子管道和关联身份，不向公开清单贡献该入口。父协调器通过公开工具库持有监督进程，监督进程原生持有Node/代理句柄并报告出生、退出及最终成员空集合；监督报告还必须与监督进程自身实际退出、真实CLI owner及管道结束一起核对。私有强杀只发送一次，之后等待稳定OS身份的退出；监督进程失联、自身被杀或父Future丢弃而证据未全，均不能自报清理确认。

| 平台 | 创建与持有方式 | 强杀后的实际证据 | 必须失败的情况 |
| --- | --- | --- | --- |
| Windows | Node启动前以暂停创建方式加入本调用Job Object；不允许breakaway，再恢复线程。监督持有Job和实际进程句柄，SDK代理自动继承本调用Job。 | 终止本Job后，等待成员退出及ActiveProcessZero，并查询当前active=0；Node/已登记代理句柄退出，最后监督自身退出。 | 绑定失败、成员逃逸、查询失败、剩余成员、清理期限用尽；KillOnJobClose仅兜底，不能替代观察证据。 |
| Linux | 私有监督先设置PR_SET_CHILD_SUBREAPER；Node exec前建立独立受控process group，sentinel保留组身份；不得在宿主全局调用waitpid抢其他Tokio child。 | 对仍持有身份的组停止一次；实际waitpid/reap登记子进程和被收养成员至ECHILD，并结合稳定pidfd观察Node/代理退出；最后回收sentinel和监督。 | 组建立失败、成员资格不全、缺reap、持续后代或期限用尽；kill返回成功不表示退出。 |
| macOS | Node执行前建立独立受控组，由本调用sentinel保留组身份；kqueue NOTE_EXIT/NOTE_FORK与libproc PROC_PGRP_ONLY成员及出生身份查询共同核对。Apple XNU明确NOTE_TRACK/NOTE_TRACKERR/NOTE_CHILD自10.5起不受支持，不能作为可执行资格。 | Node实际wait退出后，核对受控组仅剩固定sentinel及已登记代理退出，再回收sentinel并确认监督退出；固定SDK和代理不得detached/unref或自行spawn工具。 | 事件丢失、未知或逃逸成员、查询失败、缺退出或期限用尽；组成员为空不独立证明任意CLI后代退出，不对可能复用的PID反复发信号。 |

三平台必须各有原生失败/强杀回归；Windows通过不替代Linux/macOS，合成退出帧不替代OS句柄。初始部署只对已经取得完整资格的平台报告可用，其余为有限unsupported/unqualified；完整目标仍包含三平台实现与原生验收，不把未取得资格的平台从范围删除。

SDK代理按设计不spawn真实CLI或任何工具，固定SDK无unref/detached；实际回归须故意提前关闭generator、杀Node、杀代理、破坏握手与制造延迟退出，证明监督及CLI所有者仍可分别收口。若SDK档案改变派生模型、第三方扩展绕过登记或CLI留下未经确认的后代，必须阻断资格并明确资源失败。跨平台公共工具执行接口若缺少必需能力，由主代理另定最小公共契约；本代理不私改公共库或把系统监督责任塞进宿主AI分支。

## 8. 文件职责、生产写集与最低证据

| 建议落点 | 输入与输出 | 副作用与职责边界 |
| --- | --- | --- |
| plugins/ai-sdk/src/lib.rs、main.rs、entry.rs | 公开操作、协议4/5处理器及有限结果 | 只装配公开runtime与所属模块，不包含SDK解析或平台监督细节。 |
| src/config.rs、model.rs、runtime.rs | 严格部署配置、结果结构、固定资格档案 | 有界检查部署入口与版本；不下载、不安装，不把配置文字当真实运行。 |
| src/sessions.rs | provider/thread资格、锁与原子状态 | 所有文件工作进入受限阻塞worker；跨进程串行、uncertain与closed规则。 |
| src/assistant.rs | 旧助手prompt与最多四轮schema编排 | 同一原期限内顺序调用桥；不回退、不重放，不直接持有OS进程。 |
| src/bridge/coordinator.rs | 原InvocationContext、项目、轮次、候选 | 统一准入与终态；不内嵌平台命令或同步文件I/O。 |
| src/bridge/transport.rs、proxy.rs、events.rs | 有界本机帧、SDK exec代理、固定公开事件 | 握手、背压、argv/stdin核对及事件白名单分责；代理不spawn工具。 |
| src/bridge/process.rs、resources.rs | 真实CLI owner、Node监督、资源状态 | 公开tool-process与后台资源所有权、固定清理点、锁粘性。 |
| src/supervision/mod.rs、windows.rs、linux.rs、darwin.rs | 私有监督启动及OS出生/退出证据 | 平台原生句柄与回收；不依赖宿主，不给公共路由加AI分支。 |
| worker/src/index.ts、protocol.ts、sdk.ts、shutdown.ts | 固定SDK、私有控制/候选 | 实际startThread/resumeThread/runStreamed、有界输出、合作停止和自然退出；禁止任意动态加载。 |
| worker/dist/、包锁与构建脚本 | 固定官方依赖及受控构建产物 | 生成产物不手改；正式包保留依赖、worker、代理及平台身份。 |
| 独立协议/原生/服务驱动 | 真插件、模拟CLI、SDK档案和宿主 | 测试写集与生产分开；HTTP/MCP、浏览器与分发不借记CLI插件旧结果。 |

范式采用契约先行、边界与失败行为回归，再做实际SDK和模型资格。先冻结输入、归属、IPC、四轮助手与资源状态，开发批交测试后立即推进独占下一项；普通缺陷集中回流，真实资源泄漏、公开契约错误及失败资格冒充成功及时修复。生成类型、公共SDK、宿主和workspace修改只由主代理协调。

最低实现证据包括：严格输入和编码后的字节限额；CLI/SDK同UUID拒绝跨归属；首线程uncertain、锁跨取消/Future丢弃/强杀持续持有；恢复不重放；真实官方SDK加载及start/resume/stream；助手一轮/四轮/失败schema；私有握手错ID/错角色/重复/超限/慢接收；真实CLI非零、两路输出限额和原期限；正常、合作取消、到期、Node强杀、代理强杀、缺成员与迟到结果；每目标OS实际回收；插件热卸载与代际阻断；HTTP/MCP同终态、前端票据/日志关联；当前原生包/npx真实安装与身份核对；真实认证、模型、MCP/命令工具及项目副作用的可审计验收。

生产实施按互不重叠批次推进：私有输入/配置/资格与会话；固定worker/代理/有界transport与真实SDK；三平台监督/取消闭合与助手；集成公开清单及生成类型；服务/浏览器/当前正式分发与真实模型资格。每批冻结后由独立测试消费，研发继续不冲突文件；即使局部通过也保持SDK整体待完成，直到本节全部必要证据和所属端门禁闭合。

初始裁定时只有取证、README和配置草案；最新已批准并实施的私有生产与8项SDK回归见本文开头。模型、Rust完整执行链、宿主HTTP/MCP、浏览器、npx与三平台原生监督仍待独立验收，不把本文设计、模拟CLI或旧CLI/Harmony通过计成新SDK完整完成。
