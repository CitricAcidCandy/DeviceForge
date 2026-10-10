//! 独立的异步工具执行库，不包含宿主领域、平台命令或插件协议。

mod command;
mod error;
mod execution;
mod lifecycle;
mod options;
mod ownership;
mod streams;

pub use error::{Error, OutputStream, Result};
pub use execution::{
    Output, capture, capture_to_file, capture_to_file_with_lease, capture_with_lease,
};
pub use options::{
    DEFAULT_OUTPUT_LIMIT, Environment, ExecutionOptions, MAX_CLEANUP_TIMEOUT, ToolCommand,
};
