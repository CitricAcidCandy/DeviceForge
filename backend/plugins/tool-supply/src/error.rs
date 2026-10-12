//! 公开失败不包含部署路径、下载地址或网络凭据。
#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("操作已取消")]
    Cancelled,
    #[error("工具供应执行期限已到期")]
    Timeout,
    #[error("数据超过工具供应限额")]
    TooLarge,
    #[error("输入或清单无效：{0}")]
    Invalid(&'static str),
    #[error("工具供应依赖失败：{0}")]
    Dependency(&'static str),
    #[error("工具供应文件操作失败：{0}")]
    Io(&'static str),
    #[error("模块正在安装或移除")]
    Busy,
    #[error("清单缓存正在读取或提交")]
    CacheBusy,
    #[error("下载文件 SHA-256 不匹配")]
    Checksum,
    #[error("工具供应回滚或临时资源清理未确认")]
    Cleanup,
}
pub(crate) type Result<T> = std::result::Result<T, Error>;
