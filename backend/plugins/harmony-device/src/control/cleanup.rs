use super::{Control, Waiting};
use crate::{Error, Result};
use deviceforge_tool_process::{
    Environment, ExecutionOptions, Output, ToolCommand, capture_with_lease,
};
use std::sync::atomic::Ordering;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

impl Control {
    pub(crate) async fn capture_cleanup(&self, args: &[String]) -> Result<Output> {
        let until = self.lease.cleanup_point()?;
        if Instant::now() >= until {
            return Err(Error::CleanupFailed);
        }
        let mut command = ToolCommand::new(&self.executable, args);
        command.environment = Environment::Restricted;
        let mut options = ExecutionOptions::new(until);
        options.cleanup_timeout = until.saturating_duration_since(Instant::now());
        let mut waiting = Waiting::new(
            CancellationToken::new(),
            self.unresolved.clone(),
            &self.lease,
        );
        let result = tokio::time::timeout_at(
            until,
            capture_with_lease(command, options, waiting.stop.clone(), self.lease.clone()),
        )
        .await
        .map_err(|_| Error::CleanupFailed)?;
        if matches!(
            result,
            Err(deviceforge_tool_process::Error::CleanupFailed { .. })
        ) {
            return Err(Error::CleanupFailed);
        }
        waiting.confirmed();
        result.map_err(Into::into)
    }

    pub(crate) async fn cleanup_work<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn Fn() -> Result<()>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let until = self.lease.cleanup_point()?;
        let permit = tokio::time::timeout_at(until, self.lease.slots.clone().acquire_owned())
            .await
            .map_err(|_| Error::CleanupFailed)?
            .map_err(|_| Error::CleanupFailed)?;
        let lease = self.lease.clone();
        let mut waiting = Waiting::new(
            CancellationToken::new(),
            self.unresolved.clone(),
            &self.lease,
        );
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _lease = lease;
            let check = || {
                if Instant::now() >= until {
                    Err(Error::CleanupFailed)
                } else {
                    Ok(())
                }
            };
            check()?;
            let result = work(&check);
            check()?;
            result
        });
        let joined = tokio::time::timeout_at(until, worker)
            .await
            .map_err(|_| Error::CleanupFailed)?;
        let result = joined.map_err(|_| Error::CleanupFailed)?;
        waiting.confirmed();
        if result.is_err() {
            self.unresolved.store(true, Ordering::Release);
        }
        result
    }
}
