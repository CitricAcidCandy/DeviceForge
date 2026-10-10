//! 原截止点、固定工具入口和直接进程租约；不承担平台命令或共享server所有权。
mod file;
mod resources;
use crate::{Error, Result};
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::{Execution, InvocationContext};
use deviceforge_tool_process::{
    Environment, ExecutionOptions, Output, ToolCommand, capture_with_lease,
};
pub(crate) use resources::{Lease, Waiting};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;

pub(crate) struct Control {
    pub(crate) context: InvocationContext,
    pub(crate) executable: String,
    pub(crate) lease: Arc<Lease>,
    pub(crate) unresolved: Arc<AtomicBool>,
}

struct ToolGuard {
    unresolved: Arc<AtomicBool>,
    confirmed: bool,
}

impl Drop for ToolGuard {
    fn drop(&mut self) {
        if !self.confirmed {
            self.unresolved.store(true, Ordering::Release);
        }
    }
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

    pub(crate) async fn capture(
        &self,
        args: &[String],
        short_limit: Option<Duration>,
    ) -> Result<Output> {
        self.check()?;
        let total = Instant::from_std(self.context.deadline());
        let deadline = match short_limit {
            Some(limit) if !limit.is_zero() => total.min(
                Instant::now()
                    .checked_add(limit)
                    .ok_or(Error::Invalid("工具短期限无法表示"))?,
            ),
            Some(_) => return Err(Error::Invalid("工具短期限必须大于零")),
            None => total,
        };
        let mut command = ToolCommand::new(&self.executable, args);
        command.environment = Environment::Restricted;
        let mut guard = ToolGuard {
            unresolved: self.unresolved.clone(),
            confirmed: false,
        };
        let result = capture_with_lease(
            command,
            ExecutionOptions::new(deadline),
            self.context.cancellation(),
            self.lease.clone(),
        )
        .await;
        guard.confirmed = !matches!(
            result,
            Err(deviceforge_tool_process::Error::CleanupFailed { .. })
        );
        if !guard.confirmed {
            return Err(Error::CleanupFailed);
        }
        // 工具库的取消优先次序不改变本插件公开上下文的到期优先规则。
        self.check()?;
        result.map_err(Into::into)
    }

    pub(crate) async fn capture_scoped(&self, args: &[String]) -> Result<Output> {
        let mut command = ToolCommand::new(&self.executable, args);
        command.environment = Environment::Restricted;
        self.capture_scoped_command(command).await
    }

    pub(crate) async fn capture_private(
        &self,
        executable: &str,
        args: &[String],
        directory: &Path,
    ) -> Result<Output> {
        let mut command = ToolCommand::new(executable, args);
        command.environment = Environment::Restricted;
        command.directory = Some(directory);
        for key in ["TEMP", "TMP", "TMPDIR"] {
            command
                .env
                .insert(key.into(), directory.as_os_str().to_owned());
        }
        self.capture_scoped_command(command).await
    }

    async fn capture_scoped_command(&self, command: ToolCommand<'_>) -> Result<Output> {
        self.check()?;
        let mut guard = ToolGuard {
            unresolved: self.unresolved.clone(),
            confirmed: false,
        };
        let result = {
            let work = capture_with_lease(
                command,
                ExecutionOptions::new(self.context.deadline().into()),
                self.context.cancellation(),
                self.lease.clone(),
            );
            tokio::pin!(work);
            let cancel = self.context.cancellation();
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(self.context.deadline().into()) => {
                    let until = self.lease.cleanup_point()?;
                    tokio::time::timeout_at(until, &mut work).await.map_err(|_| Error::CleanupFailed)?
                },
                _ = cancel.cancelled() => {
                    let until = self.lease.cleanup_point()?;
                    tokio::time::timeout_at(until, &mut work).await.map_err(|_| Error::CleanupFailed)?
                },
                result = &mut work => result,
            }
        };
        guard.confirmed = !matches!(
            result,
            Err(deviceforge_tool_process::Error::CleanupFailed { .. })
        );
        if !guard.confirmed {
            return Err(Error::CleanupFailed);
        }
        self.check()?;
        result.map_err(Into::into)
    }

    pub(crate) fn finish(&self, result: Result<serde_json::Value>) -> Execution {
        if matches!(result, Err(Error::CleanupFailed))
            || self.unresolved.load(Ordering::Acquire)
            || Arc::strong_count(&self.lease) != 1
        {
            return Execution {
                outcome: Err(Error::CleanupFailed.to_string()),
                cleanup: CleanupOutcome::Failed,
            };
        }
        let result = self.context.check().map_err(Error::from).and(result);
        Execution::complete(
            result
                .map(deviceforge_plugin_runtime::Output::from)
                .map_err(|error| error.to_string()),
        )
    }
}
