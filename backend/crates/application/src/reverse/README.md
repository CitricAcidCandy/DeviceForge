# 反编译和 SDK 检测操作贡献

作用：通过 PackageReverse 注册公开操作，让 HTTP / MCP 复用任务层与取消机制。

快速开始：将 ReverseOperations(Arc<dyn PackageReverse>) 加入 Application 执行器列表。

| 操作 | 必填参数 | 返回模型 |
| --- | --- | --- |
| android.package.decode | artifact_id | DecodedPackage |
| android.package.scan_sdks | artifact_id、rules | SdkScan |

artifact_id 使用 UUID 输入模式；rules 必须为 1 到 100 条，每条包含 name、package_path，可选 class_name（允许 null）。输入模式拒绝未知属性；适配器进一步校验标识符、名称唯一性与产物类型。

任务失败不发布成功结果；decode 成功的 result.artifact.id 可传给 scan_sdks。模型由 Rust 类型生成在 OpenAPI components.schemas。
