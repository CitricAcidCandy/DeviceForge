# 分包应用操作
SplitOperations 注册 android.package.extract_splits 与 android.app.install_apks，复用通用 HTTP / MCP 任务层。以领域类型生成模式并增加规格列表 uniqueItems 约束，执行时再次验证，不把任意工具参数交给端口。行为测试见 tests/splits.rs。

旧 `execute` 委托默认 `ExecutionContext`。新入口先通过 `operation_budget::check` 检查原截止点和取消，再匹配操作和转换原请求；到期与取消同现时优先 Timeout。提取调用 `extract_with_context` 并直接转发 `Some(D)`；安装仍调用旧 `install`，只有应用入口预检，不表示安装全阶段已经接通原截止点。输入模式、操作 ID 与输出 DTO 保留。

`has_unresolved_resources` 实时转发同一个 SplitPackages 实例的资源观测。提取的持久未确认可能使随后安装被现有任务层收口为 CleanupFailed，是本批显式增加的风险诊断；本模块既不清零也不隐藏标记，不能宣称安装所有行为保持不变。

`context_tests.rs` 使用纯 Recorder 与旧仅实现者，覆盖提取原截止点、安装旧端口、取消树、默认兼容、预拒零调用、规格和标识验证、未知操作顺序及共享观测。模拟端口返回成功后的风险仍可见；任务层具体终态、工具清理、真实安装与真机另行验收。
