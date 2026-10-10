# 安装包分析用例贡献

作用：把 PackageAnalyzer 端口注册为公开操作，供 HTTP 和 MCP 共享输入模式、任务状态、并发控制及取消。适用于替换旧版任意命令形式的 APK 分析接口。

快速开始：在服务器装配时将 PackageOperations(Arc<dyn PackageAnalyzer>) 加入 Application 执行器列表，不需要添加业务专用路由。

| 操作 | 必填参数 | 可选参数 | 返回模型 |
| --- | --- | --- | --- |
| android.package.manifest | artifact_id | module（AAB 默认 base） | PackageManifest |
| android.package.signature | artifact_id | 无 | PackageSignature |
| android.package.extract_apk | artifact_id、entry | 无 | ExtractedApk |

输入模式拒绝额外属性；artifact_id 使用 UUID 格式；module 以字母开头，只允许字母、数字和下划线，最多 80 字节；entry 精确指定 APKS 目录条目，最多 500 字节。适配器仍做类型、路径及完整性检查。错误由统一任务终态承载，签名验证失败不返回 verified=true。

execute_with_context 先用现有 operation_budget::check 检查原截止点与取消，再按原输入语义转交 PackageAnalyzer 的三个 *_with_context 入口。Some(D) 只在预检时转换为 Tokio 时钟类型，传给端口的仍是原 ExecutionContext，不创建新截止点；到期与取消同现时按 Timeout 诊断。预过期或预取消不会调用任何包分析端口。旧 execute 委托 ExecutionContext::default()，保留 None 兼容行为。

has_unresolved_resources 实时转发底层 PackageAnalyzer 状态，不缓存为 false；同步工作与工具进程的真实追踪、许可和目录 lease 由基础设施实现，应用接线不声称底层已排空。三操作与输入模式、返回 DTO、HTTP/MCP 字段保持原定义。

context_tests 使用 Recorder 与只实现旧三方法的适配器，覆盖原 D/取消树/参数/DTO 三流传递、旧 execute 委托、旧默认入口兼容、预取消/预过期零调用、原输入错误及未确认资源状态转发。该测试文件不引用包核心、infrastructure 或实际工具；源码落盘不等于已执行，编译与实跑由主代理统一门禁记录。
