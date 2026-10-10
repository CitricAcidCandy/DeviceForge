#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("操作已取消")]
    Cancelled,
    #[error("插件或工具执行期限已到期")]
    Timeout,
    #[error("数据超过插件限额")]
    TooLarge,
    #[error("输入无效：{0}")]
    Invalid(&'static str),
    #[error("工具依赖失败：{0}")]
    Dependency(&'static str),
    #[error("文件操作失败：{0}")]
    Io(&'static str),
    #[error("插件资源清理未确认")]
    CleanupFailed,
}

pub(crate) type Result<T> = std::result::Result<T, Error>;

impl From<deviceforge_plugin_runtime::ContextError> for Error {
    fn from(error: deviceforge_plugin_runtime::ContextError) -> Self {
        match error {
            deviceforge_plugin_runtime::ContextError::Timeout => Self::Timeout,
            deviceforge_plugin_runtime::ContextError::Cancelled => Self::Cancelled,
        }
    }
}

impl From<deviceforge_tool_process::Error> for Error {
    fn from(error: deviceforge_tool_process::Error) -> Self {
        use deviceforge_tool_process::Error as Tool;
        match error {
            Tool::Cancelled => Self::Cancelled,
            Tool::Timeout => Self::Timeout,
            Tool::OutputTooLarge { .. } => Self::TooLarge,
            Tool::CleanupFailed { .. } => Self::CleanupFailed,
            _ => Self::Dependency("HDC客户端执行失败，请检查部署配置"),
        }
    }
}
