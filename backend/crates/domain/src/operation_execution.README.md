# 普通操作有效预算元数据

`operation_execution::{OperationExecution, OperationExecutionSource}` 从领域根导出。`Operation.execution` 可选，非空为 `{"api_version":1,"total_timeout_ms":60000,"source":"default"}`；source 仅允许 default / declared。模块只表达和校验元数据，不执行计时、排队、进程或存储。

公开常量 `EXECUTION_API_VERSION` 为 1，`DEFAULT_TOTAL_TIMEOUT_MS` 为 60000，最小/最大预算常量为 1 / 3600000。严格 JSON 解码和 `validate()` 拒绝非法版本或数值，未知字段拒绝；Rust 构造同样需要校验。省略/null 保持旧 Operation 可读，并在序列化时省略。

基础设施只映射显式 declared 值；普通默认值由应用注册层按实际贡献关联固化。设备发现、能力和性能专用预算不放入普通 execution，别名继承实际目标元数据。历史 Job 不按当前目录反填预算，Executor/JobStore 端口和进程协议帧保持原签名。

所属纯回归已编写，覆盖旧 JSON、来源、边界、格式拒绝及 invalid_input 错误；本批未运行测试或生成器。
