use deviceforge_plugin_runtime::ContextError;

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("终端输入无效：{0}")]
    Invalid(&'static str),
    #[error("终端部署配置无效：{0}")]
    Configuration(&'static str),
    #[error("终端工具无法启动")]
    Spawn,
    #[error("终端工具管道失败")]
    ProcessIo,
    #[error("终端原字节输入或输出已关闭")]
    Closed,
    #[error("终端操作已取消")]
    Cancelled,
    #[error("终端原总期限已到期")]
    Timeout,
    #[error("终端输入或输出超过限额")]
    TooLarge,
    #[error("终端工具退出码为{0:?}")]
    NonZero(Option<i32>),
    #[error("终端进程或资源清理未确认")]
    CleanupFailed,
}

pub(crate) type Result<Value> = std::result::Result<Value, Error>;

impl From<ContextError> for Error {
    fn from(error: ContextError) -> Self {
        match error {
            ContextError::Cancelled => Self::Cancelled,
            ContextError::Timeout => Self::Timeout,
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
            Tool::Spawn(_) => Self::Spawn,
            Tool::NonZeroExit { code, .. } => Self::NonZero(code),
            _ => Self::ProcessIo,
        }
    }
}

impl From<deviceforge_plugin_runtime::session::SessionIoError> for Error {
    fn from(error: deviceforge_plugin_runtime::session::SessionIoError) -> Self {
        use deviceforge_plugin_runtime::session::SessionIoError as Io;
        match error {
            Io::Cancelled => Self::Cancelled,
            Io::Timeout => Self::Timeout,
            Io::ChunkTooLarge { .. } | Io::InputTooLarge { .. } | Io::OutputTooLarge { .. } => {
                Self::TooLarge
            }
            _ => Self::Closed,
        }
    }
}
