# 性能会话消费

本模块消费宿主八个 `android.performance.*` 操作，不执行平台采样、不新增路由或页面。`createPerformance` 注入公开 `HostContext` 的 `submit/getJob`，现有 HTTP 客户端、任务用例和浏览器 SDK 保持原实现。`createHttpPerformance` 复用 shared/jobs HTTP 网关，由 app runtime 持有并在关闭时 dispose；`host.performance` v1 服务供可信浏览器插件通过公开扩展服务消费。会话、样本页及历史列表类型直接索引生成契约。能力响应当前没有生成组件，校验后映射为独立消费视图。

`start/inspect/pause/resume/stop` 校验直接会话结果，`samples/list` 校验各自分页对象，`capabilities` 校验实际指标与限制。提交只执行一次，排队或执行中 Job 继续查询，只有成功终态才解码 `Job.result`。普通 `performance.sample` 的 `result/artifacts` 包装不接受为会话结果。`PerformanceJobFailure` 保留真实失败 Job、字符串 error、提交与最后查询日志；等待失败保留已知 Job 和原错误 cause。查询日志不当作执行日志，任务编号不当作日志编号。

创建参数保持旧 `target.device_id/package`、间隔和时长，不能发送来源或设备代际字段。服务器返回的 `source` 是权威，目录预检与执行之间发生重载时可能绑定新代，本模块不承诺客户端代际 CAS。旧记录省略来源、合成源省略设备，真实 null/缺省均原样保留，不从当前目录反填。既有会话的目标、来源及开始时间不能在查询后变更。同 ID 重载需要新建会话，不自动恢复或迁移旧会话。

`select/refresh/inspect/samples` 使用独立视图代次；同一会话的查询和控制串行，取消等待的下游即使晚到也不能回写当前快照。更低 revision、样本计数与游标不能回退，样本按 sequence 去重，失败不推进游标。控制失败后标为结果未确认，恢复前必须显式 inspect；不会重放控制。跨浏览器竞争仍以服务器结果为准，没有 expectedRevision 保证。

`invalidateSource` 由调用方在来源观测失效时调用，撤销新建、恢复、能力查询及当前观测等待，保留已取得的会话和样本。`refreshSourceObservation` 只表示调用方重查了来源，服务器仍做当前代真实准入；来源展示标签不证明设备在线。历史 inspect/list/samples 和 stop 不依赖此可用标记，源码不把会话终态或暂停/停止响应当作插件排空回执。draining、cleanup_failed 等管理状态由已有管理模块消费。

CPU、RSS、FPS 的缺省/null 与有效零分别保留；本模块不重算 CPU 差分或帧窗口。关闭消费者只取消请求、等待及订阅，不取消已提交 Job、不自动 stop 后台会话。HTTP 等待取消、Job 取消、会话停止与插件排空分别处理。没有来源时保留真实错误，不隐式回退 ADB。

本批回归使用注入网关，证明结果规则与客户端状态；生成同步、严格检查、完整测试、构建及真实服务证据由主代理协调。它们不替代来源排空、SQLite 持久化、真实进程清理、真机指标或产品 UI 验收。React 与设计稿不在本模块范围内。
