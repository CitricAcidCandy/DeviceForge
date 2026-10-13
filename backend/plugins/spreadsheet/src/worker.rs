use crate::{Error, Result};
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

static SLOTS: Semaphore = Semaphore::const_new(1);
#[derive(Clone)]
pub(crate) struct Control { deadline: Instant, cancel: CancellationToken }
impl Control {
    pub(crate) fn check(&self) -> Result<()> {
        if Instant::now() >= self.deadline { return Err(Error::Timeout); }
        if self.cancel.is_cancelled() { return Err(Error::Cancelled); }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn test(deadline: Instant, cancel: CancellationToken) -> Self {
        Self { deadline, cancel }
    }
}
struct Waiting { stop: CancellationToken, armed: bool }
impl Drop for Waiting {
    fn drop(&mut self) { if self.armed { self.stop.cancel(); } }
}
pub(crate) async fn run(context: InvocationContext,
    work: impl FnOnce(&Control) -> Result<Output> + Send + 'static) -> Execution {
    let result = execute(context, work).await;
    if matches!(result, Err(Error::CleanupFailed)) {
        Execution { outcome: Err(Error::CleanupFailed.to_string()), cleanup: CleanupOutcome::Failed }
    } else {
        Execution::complete(result.map_err(|error| error.to_string()))
    }
}
async fn execute(context: InvocationContext,
    work: impl FnOnce(&Control) -> Result<Output> + Send + 'static) -> Result<Output> {
    context.check()?;
    let cancel = context.cancellation();
    let deadline = context.deadline();
    let permit = tokio::select! {
        biased;
        _ = tokio::time::sleep_until(deadline.into()) => return Err(Error::Timeout),
        _ = cancel.cancelled() => return Err(Error::Cancelled),
        permit = SLOTS.acquire() => permit.map_err(|_| Error::CleanupFailed)?,
    };
    context.check()?;
    let stop = cancel.child_token();
    let control = Control { deadline, cancel: stop.clone() };
    let mut waiting = Waiting { stop, armed: true };
    let mut worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        control.check()?;
        let result = work(&control);
        control.check()?;
        result
    });
    let cause = tokio::select! {
        biased;
        _ = tokio::time::sleep_until(deadline.into()) => Error::Timeout,
        _ = cancel.cancelled() => Error::Cancelled,
        joined = &mut worker => {
            waiting.armed = false;
            let result = joined.map_err(|_| Error::CleanupFailed)?;
            context.check()?;
            return result;
        },
    };
    waiting.stop.cancel();
    // 只有真实阻塞句柄结束才能确认清理；保留原执行期限，不重授预算。
    let joined = tokio::time::timeout(Duration::from_secs(2), &mut worker).await
        .map_err(|_| Error::CleanupFailed)?;
    waiting.armed = false;
    drop(joined.map_err(|_| Error::CleanupFailed)?);
    Err(cause)
}
