//! 副作用前复核共享截止点；不承担进程终止或阻塞任务停止确认。
use apk_domain::{Error, Result};
use std::future::{Future, pending};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub(crate) fn check(cancel: &CancellationToken, deadline: Option<Instant>) -> Result<()> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(Error::Timeout);
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(())
}

/// 外层到期会同时取消令牌；只修正取消诊断，绝不覆盖清理未确认错误。
pub(crate) fn classify(error: Error, deadline: Option<Instant>) -> Error {
    match error {
        Error::Cancelled if deadline.is_some_and(|deadline| Instant::now() >= deadline) => {
            Error::Timeout
        }
        other => other,
    }
}

async fn elapsed(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending::<()>().await,
    }
}

/// 等待取消或到期会丢弃异步工作；已启动的阻塞工作须自行持有资源守卫。
pub(crate) async fn run<T>(
    cancel: &CancellationToken,
    deadline: Option<Instant>,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    check(cancel, deadline)?;
    let value = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(classify(Error::Cancelled, deadline)),
        _ = elapsed(deadline) => return Err(Error::Timeout),
        result = work => result?,
    };
    check(cancel, deadline)?;
    Ok(value)
}

#[cfg(test)]
mod tests;
