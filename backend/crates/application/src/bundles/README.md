# AAB 构建应用操作
BundleOperations 注册 android.package.build_apks，以领域类型生成 JSON Schema，HTTP 与 MCP 共用任务层。执行时再次反序列化和验证，再交给 BundleBuilder；未知操作、取消和非法输入不会调用端口。测试见 tests/bundles.rs。

旧 `execute` 委托默认 `ExecutionContext`。新 `execute_with_context` 保留先拒绝未知操作的顺序，再通过 `operation_budget::check` 检查原截止点和取消，然后转换原请求、验证并调用 `build_with_context`。到期与取消同现时诊断为 Timeout，`Some(D)` 直接传递，`None` 不在本模块补预算；操作 ID、输入模式和输出 DTO 均沿用旧内容。

`has_unresolved_resources` 实时转发构建适配器，应用模块不缓存或清除风险。`context_tests.rs` 使用纯 Recorder 和旧仅实现者，覆盖两种模式、原截止点与取消树、默认兼容、预拒零调用、输入错误、未知操作顺序和风险转发；不引用基础设施或包核心，真实工具与资源排空另由集成门禁验证。
