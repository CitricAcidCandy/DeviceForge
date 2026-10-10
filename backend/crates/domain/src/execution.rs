//! 执行端口的宿主上下文，只传递单调时钟截止点，不包含调度或平台实现。

#[derive(Clone, Copy, Debug, Default)]
pub struct ExecutionContext {
    /// None 保留执行器旧期限；Some 必须覆盖本次执行的所有业务阶段。
    pub deadline: Option<std::time::Instant>,
}
