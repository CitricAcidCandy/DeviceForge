use crate::Error;
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::{Execution, Output};
use deviceforge_tool_process::{Error as ToolError, StreamExit};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub(crate) struct Resources {
    unresolved: AtomicBool,
}

#[derive(Default)]
pub(crate) struct Lifecycle {
    pub lease: Arc<Resources>,
    confirmed: bool,
}

impl Lifecycle {
    pub(crate) fn finish(
        mut self,
        profile: String,
        result: std::result::Result<StreamExit, ToolError>,
        cause: Option<Error>,
    ) -> Execution {
        if matches!(result, Err(ToolError::CleanupFailed { .. }))
            || self.lease.unresolved.load(Ordering::Acquire)
            || Arc::strong_count(&self.lease) != 1
        {
            self.lease.unresolved.store(true, Ordering::Release);
            return Execution {
                outcome: Err(Error::CleanupFailed.to_string()),
                cleanup: CleanupOutcome::Failed,
            };
        }
        self.confirmed = true;
        let outcome = match (result, cause) {
            (_, Some(error)) => Err(error),
            (Err(error), None) => Err(Error::from(error)),
            (Ok(exit), None) if !exit.status.success() => Err(Error::NonZero(exit.status.code())),
            (Ok(exit), None) => Ok(Output::from(json!({
                "profile": profile,
                "exit_code": exit.status.code(),
                "stdout_bytes": exit.stdout_bytes,
                "stderr_bytes": exit.stderr_bytes,
            }))),
        };
        Execution::complete(outcome.map_err(|error| error.to_string()))
    }
}

impl Drop for Lifecycle {
    fn drop(&mut self) {
        if !self.confirmed {
            self.lease.unresolved.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests;
