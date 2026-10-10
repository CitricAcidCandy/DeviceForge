//! 插件公开失败不携带工具原文、配置路径或签名材料。
#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("操作已取消")]
    Cancelled,
    #[error("插件执行期限已到期")]
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

impl From<deviceforge_android_package_core::Error> for Error {
    fn from(error: deviceforge_android_package_core::Error) -> Self {
        use deviceforge_android_package_core::Error as Core;
        match error {
            Core::Cancelled => Self::Cancelled,
            Core::Timeout => Self::Timeout,
            Core::LimitExceeded { .. } => Self::TooLarge,
            Core::Io { .. } => Self::Io("包文件读写失败"),
            Core::EntryMissing => Self::Invalid("归档不存在指定成员"),
            Core::EntryDuplicate => Self::Invalid("归档包含重复成员"),
            _ => Self::Invalid("包结构或工具输出不符合约束"),
        }
    }
}

impl From<deviceforge_plugin_runtime::ContextError> for Error {
    fn from(error: deviceforge_plugin_runtime::ContextError) -> Self {
        match error {
            deviceforge_plugin_runtime::ContextError::Timeout => Self::Timeout,
            deviceforge_plugin_runtime::ContextError::Cancelled => Self::Cancelled,
        }
    }
}
