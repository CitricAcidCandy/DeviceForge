# 插件公开协议

作用：维护独立于宿主内部实现的版本化 JSON 协议，供任何语言插件使用。SDK 仅依赖 serde / serde_json，不依赖领域、应用或基础设施 crate。

快速开始：参阅 ../../docs/插件开发.md 和 ../../docs/插件产物协议.md；协议 1 示例在 plugins/echo，协议 2 示例在 plugins/artifact-copy。其他语言按相同 JSON 结构实现。

API：Manifest 声明入口、操作与可选产物能力；Request / Response 经标准输入 / 输出传输。PROTOCOL_VERSION 保留 1，ARTIFACT_PROTOCOL_VERSION 为 2。Response.result 区分缺失与显式 null。协议 1 序列化省略未使用的产物字段，宿主保持原成功结果。

cooperative 模块定义协议 3 控制帧、取消原因与清理确认，COOPERATIVE_PROTOCOL_VERSION 为 3；请求仍使用 Request，响应包装为 CooperativeResponse。公开异步运行库位于 ../plugin-runtime，样例位于 plugins/cooperative-demo。协议 3 仍是每任务一个进程，完整契约见 ../../docs/合作取消插件协议.md。

协议 2 的 ArtifactAccess 声明 input_fields / outputs；ArtifactContext 提供宿主准备的输入副本与输出目录，ArtifactOutput 声明已生成文件的 filename。宿主负责验证和发布，不把任务调用凭据交给插件。所有路径只对本次插件进程有效，不应作为公开任务结果返回。

验证：cargo test -p apk-plugin-sdk，覆盖 JSON 空值、版本 1 字段省略、版本 2 输出结构和未知能力字段拒绝。

性能能力通过可选 Manifest.performance 声明，公开 PerformanceTarget / PerformanceSample / FrameWindow 数据结构不引用宿主内部类型。新示例 plugins/performance-demo 仅提供合成数据；部署及 FPS 口径见 ../../docs/性能采样插件协议.md。
