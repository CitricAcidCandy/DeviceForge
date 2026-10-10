# AAB 构建领域端口
BuildApksRequest 限定产物 UUID 与 default / universal 模式，BuiltApks 保存新产物、APK 数量和通用条目。BundleBuilder 可替换，不依赖进程、路径、密钥配置或 HTTP；请求不携带服务器工具参数。领域验证与生成模式共用类型，未知字段拒绝。

`build_with_context(request, cancel, context)` 的末参为 `ExecutionContext`，只携带可选的 `std::time::Instant` 绝对截止点。默认实现调用旧 `build`，让旧仅实现者继续编译；默认兼容本身不保证旧实现已覆盖全阶段期限。支持期限的适配器覆盖新入口，`Some(D)` 原点贯穿各阶段，`None` 保留旧预算，不在领域层补充期限。

`has_unresolved_resources()` 默认返回 false；有工具清理或后台工作风险的适配器应覆盖并提供当前观测。领域端口不执行工具、清理目录或确认服务退出。
