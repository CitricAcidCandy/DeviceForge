//! 对外只返回可审计诊断，不暴露部署路径或工具环境。
#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("Frida输入无效：{0}")]
    Invalid(&'static str),
    #[error("Frida文件处理失败：{0}")]
    Io(&'static str),
    #[error("Frida输入或输出超过限额")]
    TooLarge,
    #[error("Frida工具执行失败：{0}")]
    Tool(String),
    #[error("Frida执行已取消")]
    Cancelled,
    #[error("Frida执行超过总期限")]
    Timeout,
    #[error("Frida资源退出或清理未确认")]
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
