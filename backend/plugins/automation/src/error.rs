//! 对外只返回可审计诊断，不暴露部署路径或工具环境。
#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("自动化输入无效：{0}")]
    Invalid(&'static str),
    #[error("自动化部署依赖不可用：{0}")]
    Dependency(&'static str),
    #[error("自动化文件处理失败：{0}")]
    Io(&'static str),
    #[error("自动化输入或输出超过限额")]
    TooLarge,
    #[error("自动化工具执行失败：{0}")]
    Tool(String),
    #[error("自动化执行已取消")]
    Cancelled,
    #[error("自动化执行超过总期限")]
    Timeout,
    #[error("自动化资源退出或清理未确认")]
    CleanupFailed,
}
impl From<deviceforge_plugin_runtime::ContextError> for Error {
    fn from(value: deviceforge_plugin_runtime::ContextError) -> Self {
        match value {
            deviceforge_plugin_runtime::ContextError::Timeout => Self::Timeout,
            deviceforge_plugin_runtime::ContextError::Cancelled => Self::Cancelled,
        }
    }
}
pub(crate) type Result<T> = std::result::Result<T, Error>;
