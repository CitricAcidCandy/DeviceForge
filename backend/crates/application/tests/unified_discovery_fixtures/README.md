# 统一发现公开应用集成夹具

普通总期限批次接入每任务终态资格后，主代理将原“成功存储之前”用例精确拆成资格前取消与资格后取消，当前 25 项。Store 的 BeforeSuccess 门闩位于 transition 已进入之后，代表应用已取得资格；该窗口中取消立即拒绝发现候选，历史返回须等实际事务放行，不能一边等待取消返回一边不释放事务。资格前取消另行断言 Cancelled 历史与零成功事件。原整包失败报告 artifacts/long-application-20261009-230857.txt 保留，以下为初次交接记录，最新结果见根队列。

状态：9个测试文件已写完并冻结，共24个测试函数，尚未编译或执行。测试函数数量不等于P/C/T/H/B/N合计24组验收矩阵的完成数量。契约为 `backend/docs/统一发现第二批契约.md` 的 RAW-02，包括主代理随后冻结的 F03 `begin_execution` 开始门禁。只写本目录与 `tests/unified_discovery.rs`，不引用或修改已有测试夹具、生产内部模块和根 smoke。

本套使用公开 Application、DeviceService、PluginService 与领域 JobStore/Executor。Store 是内存任务端口，保留实际终态不可覆盖及事件；同步门闩位于 create、Running、成功 transition 前、成功写入后但 transition 返回前。Executor 只记录首次业务 poll 与传入绝对期限，不启动 Node 或宿主，不代表协议传输、实际 PID、外部资源、真机、HTTP/MCP、浏览器或 npx 验收。

## 用例与矩阵对应

| 矩阵 | 已写的受控集成覆盖 |
| --- | --- |
| C01 | 三入口分别一 Job/一调用；直接结果保留 Json/PublishedArtifacts 格式；别名原 operation/input 和有限旧数组；API1/2 无 raw、API3 完整原文；坏 direct/alias 业务对象零 Job/零调用、不清旧目录；refresh 身份语法拒绝；发现模式不接受空对象时加载无贡献残留 |
| C02 | 别名与 direct 占两额度，refresh 第三项精确 conflict、零 Job；用户取消但执行器清理尚未确认时额度仍占用；管理跟踪任务收敛后额度恢复 |
| C03 | A 成功写入后暂停存储返回，B 不能执行；工作槽与同提供者串行等待耗20秒，执行端保留原30秒截止点且只剩10秒；排队/Running存储/创建存储耗尽期限时零新业务 poll |
| C04 | 成功写入前取消、transition 实际返回 Cancelled、存储失败、Succeeded之后cancel/到期/卸载；refresh分别精确 cancelled/storage_failed/timeout/conflict；已成功历史与事件保持不变；完整旧 raw 缺失/null/一坏项整次失败，空数组成功；Json伪宿主包装不发布 |
| C05 | 公开卸载返回后原入口/别名/provider/目录撤销，重载换代；旧代refresh精确conflict、零Job；历史raw/旧数组/事件不变；旧refresh等待者丢弃后的收敛不清B目录。公开快照不称中间注册原子性证明 |
| C06 | 暂未用公开端口构造 A Accepted 但回执交付暂停、B已发布的确定窗口；主代理补私有门禁或交付观测hook后再独立验收，不能用最新GET假造A回执 |
| C07 | refresh Future丢弃后仍持额度和串行资源到清理确认；cleanup_failed拒绝新/排队及重载、owner draining标记；shutdown先关闭准入后等待清理，零新Job/零新执行 |

内存Store复用在第二个Application实例上仅证明“历史不是当前目录”的受控恢复边界；真实持久库与宿主重启由 H04 独立执行。协议1/2/3、生产浏览器、同包npx分别由 T/B/N 负责，不把 ExecutorResultFormat 的受控两形态写成真实协议通过。

## 门闩与时钟真实性

- 所有用例从运行时开始暂停时钟；公开异步入口及门闩观察持续 yield，保持任务可运行，禁止存储线程等待时自动推进业务时钟。
- 墙钟12秒watchdog仅防测试失控；同步Store门闩也最多等待12秒，不改生产期限。Fixture失败时只释放自有内存门闩，不接触文件或外部进程。
- 绝对期限按 `tokio::time::Instant::from_std(context.deadline)` 观察，先达到数学截止点，再只推进1毫秒供Tokio定时器刻度唤醒；不更改原context、30秒业务预算或watchdog。
- 排队、Running持久化未返回及创建阶段是门禁前：旧目录保持，新增业务poll为0。开始门禁接受之后，即使取消/到期导致零真实进程也允许目录已清，不恢复旧观测。公开夹具只记录业务poll；`start_gate_accepted`/`tool_started`私有窗口由主代理pure gate测试验证，不能从clear反推执行。
- 创建Store被不可撤销阻塞时，调用方到期应精确timeout；阻塞create之后可能实际产生需要收敛的Job，不把这类到期路径写成“零Job”。坏业务输入的零Job要求独立严格断言。

## 仍需主代理补齐的确定窗口

1. A已Accepted但等待者未消费，B发布后释放A；返回A或冻结的失效错误，绝不能换成B；GET只用于证明当前B。
2. 父token已请求取消但bridge未取gate时，接受路径仍拒绝；该套外部接口不能独立暂停私有bridge。
3. registry→gate的注册一致性、取消/接受决定点及门禁后零真实工具启动窗口。公开装卸后的采样不替代内部快照与pure gate断言。
4. 受限存储池四槽全部占用时，准入前等待扣时与tracker注册。当前Store阶段门闩覆盖create/Running/成功返回，不声称已独立证明存储池饱和。
5. refresh业务对象额外字段由HTTP/MCP薄边界验证：公开DeviceService.refresh只接收ProviderInput，应用测试不能伪造一个不存在的业务对象参数。

交接后由主代理统一格式化并执行 `cargo test -p apk-application --test unified_discovery`、Clippy及完整后端门禁；测试角色不运行Cargo/fmt/服务。冻结不等于编译或验收通过。
