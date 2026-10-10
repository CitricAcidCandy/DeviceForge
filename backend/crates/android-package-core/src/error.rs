use std::io;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitKind {
    Entries,
    ExpandedBytes,
    FileBytes,
    ArchiveBytes,
    Depth,
    TextBytes,
    XmlNodes,
    XmlDepth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoStage {
    Metadata,
    Seek,
    Read,
    Write,
    Sync,
    Directory,
    Open,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("参数无效：{0}")]
    InvalidArgument(&'static str),
    #[error("归档无效：{0}")]
    InvalidArchive(&'static str),
    #[error("清单无效：{0}")]
    InvalidManifest(&'static str),
    #[error("签名报告无效：{0}")]
    InvalidSignature(&'static str),
    #[error("指定条目不存在")]
    EntryMissing,
    #[error("指定条目不唯一")]
    EntryDuplicate,
    #[error("超过限制 {kind:?}（{limit}）")]
    LimitExceeded { kind: LimitKind, limit: u64 },
    #[error("源文件在处理期间变化")]
    SourceChanged,
    #[error("文件 I/O 失败（{stage:?}）")]
    Io {
        stage: IoStage,
        #[source]
        source: io::Error,
    },
    #[error("操作已取消")]
    Cancelled,
    #[error("执行超时")]
    Timeout,
}

impl Error {
    pub(crate) fn io(stage: IoStage, source: io::Error) -> Self {
        Self::Io { stage, source }
    }

    pub(crate) fn limit(kind: LimitKind, limit: u64) -> Self {
        Self::LimitExceeded { kind, limit }
    }
}
