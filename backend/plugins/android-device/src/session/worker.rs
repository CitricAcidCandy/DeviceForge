use super::Session;
use crate::{Error, Result, control::Waiting};
use std::sync::atomic::Ordering;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

impl Session {
    pub(crate) async fn work<T: Send + 'static>(
        &self,
        work: impl FnOnce(&(dyn Fn() -> Result<()> + Sync)) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.control.context.check()?;
        if self.control.unresolved.load(Ordering::Acquire) {
            return Err(Error::CleanupFailed);
        }
        let caller = self.control.context.cancellation();
        let deadline = self.control.context.deadline();
        let permit = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline.into()) => return Err(Error::Timeout),
            _ = caller.cancelled() => return Err(Error::Cancelled),
            result = self.control.lease.slots.clone().acquire_owned() => result.map_err(|_| Error::CleanupFailed)?,
        };
        self.control.context.check()?;
        let stop = caller.child_token();
        let signal = stop.clone();
        let lease = self.control.lease.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _lease = lease;
            let check = || {
                if tokio::time::Instant::now() >= deadline.into() {
                    return Err(Error::Timeout);
                }
                if signal.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                Ok(())
            };
            check()?;
            let result = work(&check);
            if matches!(result, Err(Error::CleanupFailed)) {
                return result;
            }
            check()?;
            result
        });
        self.wait(worker, stop).await
    }

    async fn wait<T>(
        &self,
        mut worker: JoinHandle<Result<T>>,
        stop: CancellationToken,
    ) -> Result<T> {
        let mut waiting = Waiting::new(stop, self.control.unresolved.clone(), &self.control.lease);
        let caller = self.control.context.cancellation();
        let cause = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(self.control.context.deadline().into()) => Error::Timeout,
            _ = caller.cancelled() => Error::Cancelled,
            joined = &mut worker => {
                let result = joined.map_err(|_| Error::CleanupFailed)?;
                waiting.confirmed();
                if matches!(result, Err(Error::CleanupFailed)) {
                    self.control.unresolved.store(true, Ordering::Release);
                    return result;
                }
                self.control.context.check()?;
                return result;
            },
        };
        waiting.stop.cancel();
        let until = self.control.lease.cleanup_point()?;
        let joined = tokio::time::timeout_at(until, worker)
            .await
            .map_err(|_| Error::CleanupFailed)?;
        let result = joined.map_err(|_| Error::CleanupFailed)?;
        waiting.confirmed();
        if matches!(result, Err(Error::CleanupFailed)) {
            self.control.unresolved.store(true, Ordering::Release);
            return Err(Error::CleanupFailed);
        }
        if self.control.unresolved.load(Ordering::Acquire) {
            return Err(Error::CleanupFailed);
        }
        Err(self
            .control
            .context
            .check()
            .map_err(Error::from)
            .err()
            .unwrap_or(cause))
    }
}
