use crate::{Error, Result};
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_android_package_core::Control;
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

static SLOTS: Semaphore = Semaphore::const_new(1);

struct Waiting {
    stop: CancellationToken,
    unresolved: Arc<AtomicBool>,
    armed: bool,
}

impl Drop for Waiting {
    fn drop(&mut self) {
        if self.armed {
            self.stop.cancel();
            self.unresolved.store(true, Ordering::Release);
        }
    }
}

pub(crate) async fn run(
    context: InvocationContext,
    work: impl FnOnce(&Control<'_>) -> Result<Output> + Send + 'static,
) -> Execution {
    finish(execute(context, work).await)
}

fn finish(result: Result<Output>) -> Execution {
    if matches!(result, Err(Error::CleanupFailed)) {
        Execution {
            outcome: Err(Error::CleanupFailed.to_string()),
            cleanup: CleanupOutcome::Failed,
        }
    } else {
        Execution::complete(result.map_err(|error| error.to_string()))
    }
}

async fn execute(
    context: InvocationContext,
    work: impl FnOnce(&Control<'_>) -> Result<Output> + Send + 'static,
) -> Result<Output> {
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
    let signal = stop.clone();
    let unresolved = Arc::new(AtomicBool::new(false));
    let mut waiting = Waiting {
        stop,
        unresolved: unresolved.clone(),
        armed: true,
    };
    let mut worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let _unresolved = unresolved;
        let cancelled = || signal.is_cancelled();
        let control = Control::new(Some(deadline), &cancelled);
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
    let cleanup_until = tokio::time::Instant::now() + Duration::from_secs(2);
    let joined = tokio::time::timeout_at(cleanup_until, &mut worker)
        .await
        .map_err(|_| Error::CleanupFailed)?;
    waiting.armed = false;
    drop(joined.map_err(|_| Error::CleanupFailed)?);
    Err(cause)
}

#[cfg(test)]
mod tests;
