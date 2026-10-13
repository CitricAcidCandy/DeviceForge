mod cleanup;
mod file;
mod resources;
mod worker;

use crate::{Error, Result};
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
use deviceforge_tool_process::{
    Environment, ExecutionOptions, Output as ToolOutput, ToolCommand, capture_with_lease,
};
pub(crate) use file::ResourceGuard;
pub(crate) use resources::{AuthorizedOutput, Remote, RemotePhase};
pub(crate) use resources::{Lease, Waiting};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(crate) struct Control {
    pub(crate) context: InvocationContext,
    pub(crate) executable: String,
    pub(crate) lease: Arc<Lease>,
    pub(crate) unresolved: Arc<AtomicBool>,
}

impl Control {
    pub(crate) fn new(context: InvocationContext, executable: String) -> Self {
        Self {
            context,
            executable,
            lease: Arc::default(),
            unresolved: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self.unresolved.load(Ordering::Acquire) || Arc::strong_count(&self.lease) != 1 {
            return Err(Error::CleanupFailed);
        }
        self.context.check().map_err(Into::into)
    }

    pub(crate) async fn capture(&self, args: &[String]) -> Result<ToolOutput> {
        self.check()?;
        let mut command = ToolCommand::new(&self.executable, args);
        command.environment = Environment::Restricted;
        let caller = self.context.cancellation();
        let mut waiting = Waiting::new(caller.child_token(), self.unresolved.clone(), &self.lease);
        let result = {
            let work = capture_with_lease(
                command,
                ExecutionOptions::new(self.context.deadline().into()),
                waiting.stop.clone(),
                self.lease.clone(),
            );
            tokio::pin!(work);
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(self.context.deadline().into()) => {
                    waiting.stop.cancel();
                    let until = self.lease.cleanup_point()?;
                    tokio::time::timeout_at(until, &mut work).await.map_err(|_| Error::CleanupFailed)?
                },
                _ = caller.cancelled() => {
                    waiting.stop.cancel();
                    let until = self.lease.cleanup_point()?;
                    tokio::time::timeout_at(until, &mut work).await.map_err(|_| Error::CleanupFailed)?
                },
                result = &mut work => result,
            }
        };
        if matches!(
            result,
            Err(deviceforge_tool_process::Error::CleanupFailed { .. })
        ) {
            return Err(Error::CleanupFailed);
        }
        waiting.confirmed();
        self.check()?;
        result.map_err(Into::into)
    }

    pub(crate) fn finish(&self, result: Result<serde_json::Value>) -> Execution {
        self.finish_output(
            self.context
                .check()
                .map_err(Error::from)
                .and(result)
                .map(Output::from),
        )
    }

    pub(crate) fn finish_output(&self, result: Result<Output>) -> Execution {
        if matches!(result, Err(Error::CleanupFailed))
            || self.unresolved.load(Ordering::Acquire)
            || Arc::strong_count(&self.lease) != 1
            || !self.lease.resources_clear().unwrap_or(false)
        {
            return Execution {
                outcome: Err(Error::CleanupFailed.to_string()),
                cleanup: CleanupOutcome::Failed,
            };
        }
        let Ok(mut authorized) = self.lease.output.lock() else {
            return Execution {
                outcome: Err(Error::CleanupFailed.to_string()),
                cleanup: CleanupOutcome::Failed,
            };
        };
        if let Some(output) = authorized.as_mut() {
            if result.is_ok() && output.created && output.closed {
                output.handed_off = true;
            } else if output.created {
                return Execution {
                    outcome: Err(Error::CleanupFailed.to_string()),
                    cleanup: CleanupOutcome::Failed,
                };
            }
        }
        Execution::complete(result.map_err(|error| error.to_string()))
    }
}
