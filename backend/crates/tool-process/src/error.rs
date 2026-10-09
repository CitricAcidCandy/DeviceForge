use std::io;

/// 输出限额作用于单独的数据流，两路分别计数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

/// 公共执行错误；调用方负责把工具诊断映射成自己的公开错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("工具执行已取消")]
    Cancelled,
    #[error("工具执行超过总截止时间")]
    Timeout,
    #[error("工具执行配置无效：{0}")]
    InvalidOptions(&'static str),
    #[error("工具进程无法启动")]
    Spawn(#[source] io::Error),
    #[error("工具管道或退出状态读取失败")]
    ProcessIo(#[source] io::Error),
    #[error("工具输出文件写入失败")]
    FileIo(#[source] io::Error),
    #[error("工具 {stream:?} 输出超过 {limit} 字节")]
    OutputTooLarge { stream: OutputStream, limit: u64 },
    #[error("工具退出码 {code:?}")]
    NonZeroExit { code: Option<i32>, stderr: Vec<u8> },
    #[error("工具直接进程清理未确认")]
    CleanupFailed {
        #[source]
        cause: Box<Error>,
    },
}

pub type Result<T> = std::result::Result<T, Error>;
