#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("DEX输入无效：{0}")]
    Invalid(&'static str),
    #[error("DEX格式不支持：{0}")]
    Unsupported(&'static str),
    #[error("DEX数据超过限额")]
    TooLarge,
    #[error("DEX输入文件无法读取")]
    Io,
    #[error("DEX分析已取消")]
    Cancelled,
    #[error("DEX原总期限已到期")]
    Timeout,
    #[error("DEX工作资源清理未确认")]
    CleanupFailed,
}

pub(crate) type Result<Value> = std::result::Result<Value, Error>;

impl From<deviceforge_android_package_core::Error> for Error {
    fn from(error: deviceforge_android_package_core::Error) -> Self {
        match error {
            deviceforge_android_package_core::Error::Cancelled => Self::Cancelled,
            deviceforge_android_package_core::Error::Timeout => Self::Timeout,
            _ => Self::Invalid("控制检查失败"),
        }
    }
}

impl From<deviceforge_plugin_runtime::ContextError> for Error {
    fn from(error: deviceforge_plugin_runtime::ContextError) -> Self {
        match error {
            deviceforge_plugin_runtime::ContextError::Cancelled => Self::Cancelled,
            deviceforge_plugin_runtime::ContextError::Timeout => Self::Timeout,
        }
    }
}
