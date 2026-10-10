//! 创建交接前保留临时目录所有者，丢弃等待也不留下无主目录。
use crate::error::{Error, Result};
use deviceforge_plugin_runtime::InvocationContext;
use std::{path::PathBuf, time::Duration};
use tempfile::TempDir;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

struct Waiting(CancellationToken);

impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

fn check(deadline: Instant, cancel: &CancellationToken) -> Result<()> {
    if Instant::now() >= deadline {
        return Err(Error::Timeout);
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(())
}

pub(super) async fn create(context: &InvocationContext, scratch: PathBuf) -> Result<TempDir> {
    create_with(
        context.deadline().into(),
        context.cancellation(),
        move || {
            tempfile::Builder::new()
                .prefix("deviceforge-android-packages-")
                .tempdir_in(scratch)
                .map_err(|_| Error::Io("私有工作目录无法创建"))
        },
    )
    .await
}

async fn create_with(
    deadline: Instant,
    caller: CancellationToken,
    make: impl FnOnce() -> Result<TempDir> + Send + 'static,
) -> Result<TempDir> {
    check(deadline, &caller)?;
    let stop = caller.child_token();
    let waiting = Waiting(stop.clone());
    let mut worker = tokio::task::spawn_blocking(move || {
        check(deadline, &stop)?;
        let directory = make()?;
        if let Err(error) = check(deadline, &stop) {
            directory.close().map_err(|_| Error::CleanupFailed)?;
            return Err(error);
        }
        Ok(directory)
    });
    let cause = tokio::select! {
        biased;
        _ = tokio::time::sleep_until(deadline) => Error::Timeout,
        _ = caller.cancelled() => Error::Cancelled,
        result = &mut worker => return result.map_err(|_| Error::CleanupFailed)?,
    };
    waiting.0.cancel();
    let until = Instant::now() + Duration::from_secs(2);
    match tokio::time::timeout_at(until, worker).await {
        Ok(Ok(Ok(directory))) => {
            let closing = tokio::task::spawn_blocking(move || directory.close());
            match tokio::time::timeout_at(until, closing).await {
                Ok(Ok(Ok(()))) => Err(cause),
                _ => Err(Error::CleanupFailed),
            }
        }
        Ok(Ok(Err(Error::CleanupFailed))) | Ok(Err(_)) | Err(_) => Err(Error::CleanupFailed),
        Ok(Ok(Err(_))) => Err(cause),
    }
}

#[cfg(test)]
mod tests;
