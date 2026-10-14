# 插件公开协议

作用：维护独立于宿主内部实现的版本化 JSON 协议，供任何语言插件使用。SDK 仅依赖 serde / serde_json，不依赖领域、应用或基础设施 crate。

快速开始：参阅 ../../docs/插件开发.md 和 ../../docs/插件产物协议.md；协议 1 示例在 plugins/echo，协议 2 示例在 plugins/artifact-copy。其他语言按相同 JSON 结构实现。

API：Manifest 声明入口、操作与可选产物能力；Request / Response 经标准输入 / 输出传输。PROTOCOL_VERSION 保留 1，ARTIFACT_PROTOCOL_VERSION 为 2。Response.result 区分缺失与显式 null。协议 1 序列化省略未使用的产物字段，宿主保持原成功结果。

普通操作可在 Contribution.execution 声明版本化总预算，见 [预算模块](src/execution.README.md)。省略/null 由宿主注册层固化默认值；设备/性能专用操作不重复声明，进程请求不新增字段。本批纯声明和回归已落盘，尚未由本角色执行测试。

cooperative 模块定义协议 3 控制帧、取消原因与清理确认，COOPERATIVE_PROTOCOL_VERSION 为 3；请求仍使用 Request，响应包装为 CooperativeResponse。公开异步运行库位于 ../plugin-runtime，样例位于 plugins/cooperative-demo。协议 3 仍是每任务一个进程，完整契约见 ../../docs/合作取消插件协议.md。

context 模块新增协议 4 握手：CONTEXT_PROTOCOL_VERSION=4，ReadyFrame.command 为 ReadyCommand::Ready，StartFrame.command 为 StartCommand::Start；线格式命令严格为字符串 ready/start。两个模型拒绝未知字段、错误版本、空或超过 128 字节的请求 ID；Start 的 remaining_timeout_ns 为严格无符号整数，范围 0..=3600000000000，0 不恢复默认期限。各 validate 方法覆盖 Rust 字面量。SDK 不读时钟、不依赖 Tokio，旧 Request/Response 字段不变；本地期限与实际清理由公开运行库负责，见 ../../docs/插件执行上下文第四版裁定.md。本批源码与纯回归已落盘，尚未执行协议 4 门禁。

session 模块定义独立交互协议 5：SessionOpen/Ready/Start、持续输入/双路输出、EOF、取消及 SessionOutcome 清理终态。单块原字节最多 8192，输出使用共享递增序号；显式 null result 保持存在，失败终态不发布产物。纯校验与反序列化使用相同规则，现有 Manifest 和单任务协议 1–4 不变。运行库与宿主状态机分别落实期限、累计限额和资源所有权，见 [会话模块](src/session/README.md) 与 [第五版裁定](../../docs/contracts/交互会话协议第五版裁定.md)。

协议 2/3 的 ArtifactAccess 声明 input_fields / input_pointers / outputs；input_fields 保留顶层名称，新增 input_pointers 用 JSON Pointer 选择嵌套 ID，例如 /input/artifact_id。省略或空指针列表不改变旧清单 JSON；Rust 使用完整结构字面量时需增加该字段或采用 Default。ArtifactContext 提供宿主准备的输入副本与输出目录，嵌套输入的 field 保留原指针，ArtifactOutput 声明已生成文件的 filename。宿主负责验证和发布，不把任务调用凭据交给插件。所有路径只对本次插件进程有效，不应作为公开任务结果返回。

Manifest.devices 为可选设备声明，支持发现、提供者/设备范围和读/写能力；具体公开契约见 ../../docs/设备提供者第一阶段实施.md。嵌套产物选择的限制和实施验证见 ../../docs/插件嵌套输入产物实施.md，常驻会话另行设计。

验证：cargo test -p apk-plugin-sdk，覆盖 JSON 空值、版本 1 字段省略、版本 2 输出结构和未知能力字段拒绝。

性能能力通过可选 Manifest.performance 声明，公开 PerformanceTarget / PerformanceSample / FrameWindow 数据结构不引用宿主内部类型。[性能声明纯模块](src/performance.README.md) 区分默认 API 1 独立探针与显式 API 2 同提供者设备能力绑定；根模块继续导出原声明名。plugins/performance-demo 仅提供合成数据；部署及 FPS 口径见 ../../docs/性能采样插件协议.md，设备型迁出合同见 ../../docs/性能采样迁出最小实施裁定.md。
