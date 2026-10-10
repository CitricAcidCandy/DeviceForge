# 反编译和 SDK 检测操作贡献

作用：通过 PackageReverse 注册公开操作，让 HTTP / MCP 复用任务层与取消机制。

快速开始：将 ReverseOperations(Arc<dyn PackageReverse>) 加入 Application 执行器列表。

| 操作 | 必填参数 | 返回模型 |
| --- | --- | --- |
| android.package.decode | artifact_id | DecodedPackage |
| android.package.scan_sdks | artifact_id、rules | SdkScan |

artifact_id 使用 UUID 输入模式；rules 必须为 1 到 100 条，每条包含 name、package_path，可选 class_name（允许 null）。输入模式拒绝未知属性；适配器进一步校验标识符、名称唯一性与产物类型。

任务失败不发布成功结果；decode 成功的 result.artifact.id 可传给 scan_sdks。模型由 Rust 类型生成在 OpenAPI components.schemas。

旧 `execute` 委托默认 `ExecutionContext`，新入口先以 `operation_budget::check` 检查原截止点和取消，再读取产物 ID、匹配操作并转换原规则输入，分别调用 `decode_with_context` 和 `scan_sdks_with_context`。这个顺序保留未知操作缺少产物 ID 时的原输入错误；到期与取消同现时优先 Timeout。`Some(D)` 直接传递，不因两个端口或多阶段刷新；`None` 留给旧阶段兼容。

`has_unresolved_resources` 实时转发底层。`context_tests.rs` 用纯 Recorder 与旧仅实现者验证两流原参数、原截止点、取消树、DTO、默认兼容、预拒零调用、输入与未知操作错误顺序和资源观测；不引用基础设施或包核心，不据纯接线回归宣称实际工具已排空。
