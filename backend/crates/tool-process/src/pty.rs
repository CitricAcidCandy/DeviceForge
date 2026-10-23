//! 有界伪终端；终端控制与插件协议由调用方解释。

mod input;
mod session;
#[cfg(windows)]
mod windows;

pub use input::PtyInput;
pub use session::PtyProcess;

use crate::{Error, Result, StreamOptions, ToolCommand};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// 尺寸是字符单元；限制避免异常应用分配巨大终端屏幕。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl PtySize {
    pub fn new(cols: u16, rows: u16) -> Result<Self> {
        if !(20..=500).contains(&cols) || !(5..=200).contains(&rows) {
            return Err(Error::InvalidOptions("终端列数须为20至500，行数须为5至200"));
        }
        Ok(Self { cols, rows })
    }
}

/// 原生进程出生暂停，归入本次Job后才运行；租约覆盖PTY和整棵进程树。
pub async fn spawn_pty_with_lease<T: Send + Sync + 'static>(
    command: ToolCommand<'_>,
    options: StreamOptions,
    size: PtySize,
    cancel: CancellationToken,
    lease: Arc<T>,
) -> Result<PtyProcess> {
    options.validate()?;
    PtySize::new(size.cols, size.rows)?;
    if command.input.is_some() {
        return Err(Error::InvalidOptions("伪终端须使用运行时输入句柄"));
    }
    crate::lifecycle::preflight(&options.execution, &cancel)?;
    #[cfg(windows)]
    {
        windows::spawn(command, options, size, cancel, lease).await
    }
    #[cfg(not(windows))]
    {
        let _ = (command, lease);
        Err(Error::InvalidOptions("当前平台尚未提供合格的原生伪终端"))
    }
}
