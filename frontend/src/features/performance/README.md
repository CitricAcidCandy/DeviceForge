# 性能会话消费

本模块消费宿主八个 `android.performance.*` 操作，不执行平台采样、不新增路由或页面。`createPerformance` 注入公开 `HostContext` 的 `submit/getJob`，现有 HTTP 客户端、任务用例和浏览器 SDK 保持原实现。`createHttpPerformance` 复用 shared/jobs HTTP 网关，由 app runtime 持有并在关闭时 dispose；`host.performance` v1 服务供可信浏览器插件通过公开扩展服务消费。会话、样本页及历史列表类型直接索引生成契约。能力响应当前没有生成组件，校验后映射为独立消费视图。

`start/inspect/pause/resume/stop` 校验直接会话结果，`samples/list` 校验各自分页对象，`capabilities` 校验实际指标与限制。提交只执行一次，排队或执行中 Job 继续查询，只有成功终态才解码 `Job.result`。普通 `performance.sample` 的 `result/artifacts` 包装不接受为会话结果。`PerformanceJobFailure` 保留真实失败 Job、字符串 error、提交与最后查询日志；等待失败保留已知 Job 和原错误 cause。查询日志不当作执行日志，任务编号不当作日志编号。

创建参数保持旧 `target.device_id/package`、间隔和时长，不能发送来源或设备代际字段。服务器返回的 `source` 是权威，目录预检与执行之间发生重载时可能绑定新代，本模块不承诺客户端代际 CAS。旧记录省略来源、合成源省略设备，真实 null/缺省均原样保留，不从当前目录反填。既有会话的目标、来源及开始时间不能在查询后变更。同 ID 重载需要新建会话，不自动恢复或迁移旧会话。

`select/refresh/inspect/samples` 使用独立视图代次；同一会话的查询和控制串行，取消等待的下游即使晚到也不能回写当前快照。更低 revision、样本计数与游标不能回退，样本按 sequence 去重，失败不推进游标。控制失败后标为结果未确认，恢复前必须显式 inspect；不会重放控制。跨浏览器竞争仍以服务器结果为准，没有 expectedRevision 保证。

`invalidateSource` 由调用方在来源观测失效时调用，撤销新建、恢复、能力查询及当前观测等待，保留已取得的会话和样本。`refreshSourceObservation` 只表示调用方重查了来源，服务器仍做当前代真实准入；来源展示标签不证明设备在线。历史 inspect/list/samples 和 stop 不依赖此可用标记，源码不把会话终态或暂停/停止响应当作插件排空回执。draining、cleanup_failed 等管理状态由已有管理模块消费。

CPU、RSS、FPS 的缺省/null 与有效零分别保留；本模块不重算 CPU 差分或帧窗口。Android 采样来源当前声明 `fps=true`，能力响应包含 `fps` 指标；具体样本仍可能缺少可用帧窗口，不能用来源能力将缺测补为零。其他动态来源按实际返回的 `fps` 与 `metrics` 校验，不按平台名称推断能力。关闭消费者只取消请求、等待及订阅，不取消已提交 Job、不自动 stop 后台会话。HTTP 等待取消、Job 取消、会话停止与插件排空分别处理。没有来源时保留真实错误，不隐式回退 ADB。

FPS 单位为帧/秒，`frame_window.frames` 是窗口内实际观测帧数，`duration_ms` 为毫秒；窗口结束时间为该样本 `captured_at`。宿主按 `frames × 1000 / duration_ms` 派生，前端保留原数值和窗口，不按采样间隔重算、不累加可能重叠的窗口。Android 的 `sf_present_*` 表示所选游戏层的展示频率；采集归属与资格由后端核验，前端不把它改称引擎提交帧率或 GPU 完成帧率。

首样本与暂停恢复分别保留服务器实际返回的 CPU/FPS：CPU 差分缺测不强制清空有资格的 FPS；恢复后无 FPS 观测不会沿用旧窗口，既有历史样本仍保留。单个窗口来源可随真实展示层变化，逐样本保留；同会话的采样插件来源及代次不允许变更。来源下线后历史读取继续可用，旧记录的缺省、null 和零不从当前能力或目录补齐。新增定点 `performance-fps-consumption.test.ts` 覆盖公开宿主服务、暂停恢复、窗口来源、采样代次与下线历史；执行结果由主代理统一记录，不代替 Android 真机准确性验收。

`PerformanceReading.device_observation` 直接索引生成契约，由独立纯验证器 `device-observation.ts` 校验第一版 `api_version=1/scope=device`、固定 `device_id`、观测时效、原单位、极性与供电状态、传感器类型和重复身份。观测归属只匹配会话目标，提供者与代次继续由会话 `source` 固定。电流缺测必须保留未知极性，未知极性不接受派生功率；HAL BCL 6/7/8 不接受为摄氏温度。

`battery_net_power_mw` 是后端领域派生的有符号整机净电池功率，正值充电、负值放电；前端只校验有限数值、±5,000,000 mW 边界及有效观测/已知极性的资格，不再次计算。能力响应的 `device_observation` 缺省按 false 消费为 `deviceObservation`，true 必须同时声明 `device_observation/battery_net_power_mw` 指标；基础 `scope=main_process` 不改变。

设备电气与温度观测属于整台设备，电压按 µV、电流按 µA、温度按 °C 消费，保留实际来源、供电信息及缺测状态。有符号电流不能取绝对值；符号解释依赖观测来源，未知来源不自行推断充放电。电池数据不能称为游戏功耗，也不能归因给目标主进程。历史记录不依据当前设备目录或能力补齐观测值。

本批回归使用注入网关，证明结果规则与客户端状态；生成同步、严格检查、完整测试、构建及真实服务证据由主代理协调。它们不替代来源排空、SQLite 持久化、真实进程清理、真机指标或产品 UI 验收。React 与设计稿不在本模块范围内。
