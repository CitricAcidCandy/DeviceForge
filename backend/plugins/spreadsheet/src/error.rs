use deviceforge_plugin_runtime::ContextError;

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("表格结构损坏或不受支持")]
    Format,
    #[error("表格超过资源上限")]
    Limit,
    #[error("插件执行期限已到期")]
    Timeout,
    #[error("操作已取消")]
    Cancelled,
    #[error("阻塞工作尚未确认结束")]
    CleanupFailed,
}
pub(crate) type Result<T> = std::result::Result<T, Error>;
impl From<ContextError> for Error {
    fn from(value: ContextError) -> Self {
        match value {
            ContextError::Timeout => Self::Timeout,
            ContextError::Cancelled => Self::Cancelled,
        }
    }
}
