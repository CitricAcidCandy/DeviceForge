# 安装包分析用例贡献

作用：把 PackageAnalyzer 端口注册为公开操作，供 HTTP 和 MCP 共享输入模式、任务状态、并发控制及取消。适用于替换旧版任意命令形式的 APK 分析接口。

快速开始：在服务器装配时将 PackageOperations(Arc<dyn PackageAnalyzer>) 加入 Application 执行器列表，不需要添加业务专用路由。

| 操作 | 必填参数 | 可选参数 | 返回模型 |
| --- | --- | --- | --- |
| android.package.manifest | artifact_id | module（AAB 默认 base） | PackageManifest |
| android.package.signature | artifact_id | 无 | PackageSignature |
| android.package.extract_apk | artifact_id、entry | 无 | ExtractedApk |

输入模式拒绝额外属性；artifact_id 使用 UUID 格式；module 以字母开头，只允许字母、数字和下划线，最多 80 字节；entry 精确指定 APKS 目录条目，最多 500 字节。适配器仍做类型、路径及完整性检查。错误由统一任务终态承载，签名验证失败不返回 verified=true。
