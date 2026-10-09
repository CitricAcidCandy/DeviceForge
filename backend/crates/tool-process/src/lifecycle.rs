use crate::{Error, ExecutionOptions, Result};
use tokio::{process::Child, time};
use tokio_util::sync::CancellationToken;

pub(crate) fn preflight(options: &ExecutionOptions, cancel: &CancellationToken) -> Result<()> {
    options.validate()?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if time::Instant::now() >= options.deadline {
        return Err(Error::Timeout);
    }
    Ok(())
}

/// 错误后的直接进程回收有独立预算，不扩大业务执行截止时间。
pub(crate) async fn finish<T>(
    child: &mut Child,
    result: Result<T>,
    options: &ExecutionOptions,
) -> Result<T> {
    let error = match result {
        Ok(output) => return Ok(output),
        Err(error) => error,
    };
    // 已退出状态仍由 wait 确认；无法发送终止信号也不能略过确认。
    let _ = child.start_kill();
    match time::timeout(options.cleanup_timeout, child.wait()).await {
        Ok(Ok(_)) => Err(error),
        _ => Err(Error::CleanupFailed {
            cause: Box::new(error),
        }),
    }
}
