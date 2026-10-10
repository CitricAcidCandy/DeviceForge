//! 每进程一个同步工作许可，许可与目录随实际闭包持有。
use super::Session;
use crate::error::{Error, Result};
use deviceforge_android_package_core::Control;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio_util::sync::CancellationToken;

struct Waiting {
    signal: tokio_util::sync::CancellationToken,
    unresolved: Arc<AtomicBool>,
    armed: bool,
}
impl Drop for Waiting {
    fn drop(&mut self) {
        if self.armed {
            self.signal.cancel();
            self.unresolved.store(true, Ordering::Release);
        }
    }
}

impl Session {
    pub(crate) async fn work<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Control<'_>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.work_stopping(CancellationToken::new(), work).await
    }

    pub(super) async fn work_stopping<T: Send + 'static>(
        &self,
        stop: CancellationToken,
        work: impl FnOnce(&Control<'_>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.context.check()?;
        let permit = tokio::select! {
            biased;
            _ = stop.cancelled() => return Err(Error::Cancelled),
            result = crate::config::controlled(&self.context, async {
                self.slots.clone().acquire_owned().await.map_err(|_| Error::CleanupFailed)
            }) => result?,
        };
        let lease = self.lease.clone();
        let deadline = self.context.deadline();
        let caller = self.context.cancellation();
        let token = caller.child_token();
        let signal = token.clone();
        let worker_stop = stop.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            let _lease = lease;
            let _permit = permit;
            let cancelled = || signal.is_cancelled() || worker_stop.is_cancelled();
            let control = Control::new(Some(deadline), &cancelled);
            control.check()?;
            let result = work(&control);
            control.check()?;
            result
        });
        let mut waiting = Waiting {
            signal: token,
            unresolved: self.unresolved.clone(),
            armed: true,
        };
        let cause = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline.into()) => Error::Timeout,
            _ = caller.cancelled() => Error::Cancelled,
            _ = stop.cancelled() => Error::Cancelled,
            joined = &mut worker => {
                waiting.armed = false;
                let result = joined.map_err(|_| {
                    self.unresolved.store(true, Ordering::Release);
                    Error::CleanupFailed
                })?;
                self.context.check()?;
                return result;
            },
        };
        waiting.signal.cancel();
        let until = self.cleanup_point()?;
        let joined = match tokio::time::timeout_at(until, worker).await {
            Ok(joined) => joined,
            Err(_) => return Err(Error::CleanupFailed),
        };
        waiting.armed = false;
        let result = joined.map_err(|_| {
            self.unresolved.store(true, Ordering::Release);
            Error::CleanupFailed
        })?;
        self.context.check()?;
        match result {
            Err(error) if !matches!(error, Error::Cancelled | Error::Timeout) => Err(error),
            _ => Err(cause),
        }
    }
}
