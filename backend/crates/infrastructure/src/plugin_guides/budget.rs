//! 等待与阻塞工作复用原绝对截止点，不在每一层重置预算。
use apk_domain::{Error, Result};
use std::{future::Future, time::Instant};
use tokio_util::sync::CancellationToken;

pub(super) fn check(deadline: Instant, cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(Error::Cancelled)
    } else if Instant::now() >= deadline {
        Err(Error::Timeout)
    } else {
        Ok(())
    }
}

pub(super) async fn wait<T>(
    deadline: Instant,
    cancel: &CancellationToken,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    check(deadline, cancel)?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::Cancelled),
        _ = tokio::time::sleep_until(deadline.into()) => Err(Error::Timeout),
        result = future => result,
    }
}
