//! 工具和目录监测共用一次有界清理窗口；不确认进程树或目录删除。
use crate::execution_deadline;
use apk_domain::{Error, Result};
use std::{future::Future, time::Duration};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub(crate) async fn run<T>(
    tool: impl Future<Output = Result<T>>,
    monitor: impl Future<Output = Result<()>>,
    cancel: &CancellationToken,
    tool_cancel: &CancellationToken,
    monitor_cancel: &CancellationToken,
    deadline: Instant,
) -> Result<T> {
    execution_deadline::check(cancel, Some(deadline))?;
    tokio::pin!(tool, monitor);
    let mut tool_result = None;
    let mut monitor_result = None;
    let mut reason = None;
    let mut monitor_first = false;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => reason = Some(execution_deadline::classify(Error::Cancelled, Some(deadline))),
        _ = tokio::time::sleep_until(deadline) => reason = Some(Error::Timeout),
        result = &mut tool => tool_result = Some(result),
        result = &mut monitor => {
            monitor_first = true;
            if result.is_ok() { reason = Some(Error::Dependency("目录监测意外结束".into())); }
            monitor_result = Some(result);
        },
    }
    // 监测结果属于真实失败时保留它，工具 CleanupFailed 仍有更高优先级。
    if tool_result.is_none() {
        tool_cancel.cancel();
    }
    monitor_cancel.cancel();
    let cleanup_point = Instant::now() + Duration::from_secs(2);
    let drained = tokio::time::timeout_at(cleanup_point, async {
        tokio::join!(
            async {
                match tool_result {
                    Some(result) => result,
                    None => tool.await,
                }
            },
            async {
                match monitor_result {
                    Some(result) => result,
                    None => monitor.await,
                }
            },
        )
    })
    .await
    .map_err(|_| Error::CleanupFailed)?;
    if matches!(drained.0, Err(Error::CleanupFailed))
        || matches!(drained.1, Err(Error::CleanupFailed))
    {
        return Err(Error::CleanupFailed);
    }
    if let Err(error) = drained.1
        && (monitor_first || !matches!(error, Error::Cancelled | Error::Timeout))
    {
        return Err(error);
    }
    if let Some(error) = reason {
        return Err(error);
    }
    execution_deadline::check(cancel, Some(deadline))?;
    drained.0
}

#[cfg(test)]
mod tests;
