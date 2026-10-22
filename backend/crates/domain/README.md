# 领域内核

作用：定义任务、事件、设备、错误和执行 / 存储端口。适用于核心用例与可替换适配器。
快速开始：`cargo test -p apk-domain`。
API：`Executor::operations/execute`、`JobStore`、`identifier`、`JobStatus::is_terminal`；执行参数包含 JSON 输入和取消令牌。
领域层不引用 HTTP、数据库或操作系统进程。

`browser_configurations.rs` 定义浏览器插件的完整配置记录、正版本与有界JSON校验、CAS存储端口。它不决定文件位置或插件激活，公开字段与兼容规则见 [浏览器插件用户配置](../../docs/contracts/浏览器插件用户配置.md)。

Operation.execution 表达普通操作有效预算及 default/declared 来源，见 [预算元数据](src/operation_execution.README.md)。旧 JSON 缺省/null 保持可读；注册层负责固化默认，元数据模块不承担调度和副作用。本批回归尚未执行。

plugins.rs 定义通用插件 ID、Loaded/Draining/Unloaded 状态、代际与贡献模型，以及异步 PluginCatalog 部署读取端口。输入只包含插件 ID，不包含路径；它不定义设备提供者或常驻进程协议。PluginInfo 是 HTTP/OpenAPI 共享类型。

产物扩展：artifacts::ArtifactStore 定义流式上传、下载、元数据和压缩目录预览端口；ArtifactStream 是数据块流，不包含操作系统路径。
