# 普通操作总期限公开端口集成

主代理接收后补齐提交资格、返回清理失败及真实Future丢弃风险，当前 22 项。234935报告中22项通过，但全量门禁在另一基础设施用例失败，不能表示整批通过。原17项首轮为15通过、2失败，原报告保留于artifacts/long-application-20261009-2257.txt；创建补偿统一终态门禁，排队用例观察真实取消token后放行清理。暂停时钟不隐式推进外围两秒清理窗口，未改变生产期限。以下保留首次交接边界，最新完整执行由根队列登记。

235321新版后端六门禁和438项工作区测试通过，本目录22项全部通过，报告artifacts/long-backend-gates-20261009-235321.txt，实际输入前后零变化；两项Drop原触发失败原件仍保留于artifacts/long-drop-regression-before-20261009-234826.txt。真实进程跨61秒、HTTP/MCP、生产浏览器与新分发仍独立待验，暂停时钟结果不替代它们。

首次交接状态：LONG-TEST独立测试源码当时尚未编译或执行。冻结输入为 `backend/docs/普通操作总期限第一批契约.md`，SHA-256 `6CBE0F61F84D52617AE6939C3FE630303251F44CC37D9777733D8A0336A40914`。实际门禁由主代理串行执行，源码写入不构成验证通过。

首次交接含17个测试函数；当前22项。`executor.rs`记录实际首poll的操作、原输入、单调时钟、取消token和`ExecutionContext.deadline`；预算由公开`Operation.execution`声明。它不自行计时或消费取消token，宿主必须控制外围Future。后增夹具可在放行时返回类型化清理失败，或仅在未正常返回的真实Drop中留下粘性未确认风险；ended只证明Future返回/丢弃，不证明外部资源清理。默认预算与显式120秒的对照均核对公开目录和实际上下文，推进到61秒的场景只证明宿主暂停时钟规则。

`store.rs` 是独立内存 `JobStore`，只实现合法状态流、历史事件和终态 CAS。创建入口、Running 真正写入后、成功事务入口、列表真实占槽分别设同步门闩；没有复制应用预算或成功资格逻辑。四个 `list_async` 真实工作占满现有四槽存储池，用来证明提交等待与成功资格必须计入同一个 D，以及等待者被丢弃后实际工作仍持有许可。这里的阻塞工作是真实测试线程，没有启动工具、插件或服务。

所有用例从 `start_paused = true` 开始。等待阻塞线程或 Future 时持续 yield 并断言 Tokio 时钟不动，避免真实 I/O 等待使暂停时钟自动推进。先断言数学截止点原值，再额外推进 1 毫秒唤醒 Tokio 定时器刻度；不改变预算或传入执行器的 D。12 秒墙钟看门狗仅使失联门闩失败，不是性能期限或吞吐证据。断言失败时夹具析构放行自己的门闩，不删除文件或终止外部进程。

`completion.rs` 区分两种状态：执行器已返回但四个存储槽仍占用，成功资格尚不能取得；以及已经调用 `JobStore.transition(Succeeded)` 的不可中断事务。前者到期/取消不得调用成功提交；后者允许越过 D 收敛。资格后取消通过 `spawn_blocking` 调用公开同步 `cancel`，观测事务放行前取消结果未返回、没有取消写入，放行后返回同一 Succeeded。线程入口标记不是私有门禁内部状态观测。

`aliases.rs` 经既有公开 `PluginService::seed` 和内存 `PluginCatalog` 装配假目标，配置使用真实 wire 形状 `input: "identity"`。目录复制目标预算；目标收到目标 operation 和原输入，历史只保留一个旧 operation 的 Job。没有真实插件进程，不能据此声明清理协议通过。

主代理接收冻结版本后可在 `backend` 执行 `cargo test -p apk-application --test ordinary_deadline`，随后执行所属完整门禁。本角色未执行 Cargo、fmt、Node、npm、生成器或服务。父截止点注入没有公开 Application 入口，依主代理内部 `operation_budget` / `submit_registered_until` 测试补证；成功提交失败复位和 shutdown 资格竞争同样由主代理负责。

逐场景时间点与后续真实进程、HTTP/MCP、npx 分层计划见 `backend/docs/普通操作总期限第一批验收矩阵.md`。本套件不证明传输、输入副本、逐产物发布、进程退出、协议 3 外部资源确认或真实墙钟跨旧 60 秒。
