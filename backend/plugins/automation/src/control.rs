//! 直接工具进程与文件工作共用资源租约；未确认清理时保留私有目录。
use crate::{Error, Result};
use deviceforge_plugin_runtime::InvocationContext;
use deviceforge_tool_process::{
    Environment, ExecutionOptions, Output, ToolCommand, capture_with_lease,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct Resources {
    directory: Mutex<Option<tempfile::TempDir>>,
    unresolved: AtomicBool,
    pub outputs: Mutex<Vec<PathBuf>>,
    cleanup_at: Mutex<Option<Instant>>,
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
impl Drop for Resources {
    fn drop(&mut self) {
        if self.unresolved.load(Ordering::Acquire)
            && let Ok(slot) = self.directory.get_mut()
            && let Some(directory) = slot.take()
        {
            let _ = directory.keep();
        }
    }
}
pub(crate) struct Control {
    pub context: InvocationContext,
    pub resources: Arc<Resources>,
}
struct ToolGuard {
    resources: Arc<Resources>,
    confirmed: bool,
}
impl Drop for ToolGuard {
    fn drop(&mut self) {
        if !self.confirmed {
            self.resources.unresolved.store(true, Ordering::Release);
        }
    }
}
impl Control {
    pub(crate) fn new(context: InvocationContext) -> Self {
        Self {
            context,
            resources: Arc::default(),
        }
    }
    pub(crate) fn check(&self) -> Result<()> {
        if self.resources.unresolved.load(Ordering::Acquire) {
            return Err(Error::CleanupFailed);
        }
        self.context.check().map_err(Into::into)
    }
    pub(crate) fn failed(&self) {
        self.resources.unresolved.store(true, Ordering::Release);
    }
    pub(crate) fn cleanup_point(&self) -> Result<Instant> {
        let mut slot = self
            .resources
            .cleanup_at
            .lock()
            .map_err(|_| Error::CleanupFailed)?;
        Ok(*slot.get_or_insert_with(|| Instant::now() + Duration::from_secs(2)))
    }
    pub(crate) async fn work<T: Send + 'static>(
        &self,
        operation: impl FnOnce(InvocationContext, Arc<Resources>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.check()?;
        let context = self.context.clone();
        let lease = self.resources.clone();
        let mut guard = ToolGuard {
            resources: self.resources.clone(),
            confirmed: false,
        };
        let mut worker = tokio::task::spawn_blocking(move || operation(context, lease));
        let cancel = self.context.cancellation();
        let result = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(self.context.deadline().into()) => {
                tokio::time::timeout_at(self.cleanup_point()?, &mut worker).await.map_err(|_| Error::CleanupFailed)?.map_err(|_| Error::Io("文件工作异常"))?
            },
            _ = cancel.cancelled() => {
                tokio::time::timeout_at(self.cleanup_point()?, &mut worker).await.map_err(|_| Error::CleanupFailed)?.map_err(|_| Error::Io("文件工作异常"))?
            },
            result = &mut worker => result.map_err(|_| Error::Io("文件工作异常"))?,
        };
        guard.confirmed = true;
        self.check()?;
        result
    }
    pub(crate) async fn directory(&self, root: Option<PathBuf>) -> Result<PathBuf> {
        self.work(move |context, resources| {
            context.check()?;
            let directory = match root {
                Some(root) => {
                    crate::files::regular(&root, true)?;
                    tempfile::Builder::new()
                        .prefix("deviceforge-automation-")
                        .tempdir_in(root)
                }
                None => tempfile::Builder::new()
                    .prefix("deviceforge-automation-")
                    .tempdir(),
            }
            .map_err(|_| Error::Io("私有目录无法创建"))?;
            let path = directory.path().to_owned();
            crate::files::regular(&path, true)?;
            *resources
                .directory
                .lock()
                .map_err(|_| Error::CleanupFailed)? = Some(directory);
            context.check()?;
            Ok(path)
        })
        .await
    }
    pub(crate) async fn capture(
        &self,
        executable: &str,
        args: &[String],
        input: Option<&[u8]>,
        directory: Option<&Path>,
        cleanup: bool,
    ) -> Result<Output> {
        if !cleanup {
            self.check()?;
        }
        let deadline = if cleanup {
            self.cleanup_point()?
        } else {
            self.context.deadline().into()
        };
        let mut command = ToolCommand::new(executable, args);
        command.environment = Environment::Restricted;
        command.input = input;
        command.directory = directory;
        if let Some(directory) = directory {
            for key in ["TEMP", "TMP", "TMPDIR"] {
                command
                    .env
                    .insert(key.into(), directory.as_os_str().to_owned());
            }
        }
        let mut options = ExecutionOptions::new(deadline);
        options.stdout_limit = 8 * 1024 * 1024;
        options.stderr_limit = 1024 * 1024;
        let cancellation = if cleanup {
            CancellationToken::new()
        } else {
            self.context.cancellation()
        };
        let mut guard = ToolGuard {
            resources: self.resources.clone(),
            confirmed: false,
        };
        let work = capture_with_lease(command, options, cancellation, self.resources.clone());
        tokio::pin!(work);
        let result = if cleanup {
            tokio::time::timeout_at(deadline, &mut work)
                .await
                .map_err(|_| Error::CleanupFailed)?
        } else {
            let cancel = self.context.cancellation();
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(deadline) => tokio::time::timeout_at(self.cleanup_point()?, &mut work).await.map_err(|_| Error::CleanupFailed)?,
                _ = cancel.cancelled() => tokio::time::timeout_at(self.cleanup_point()?, &mut work).await.map_err(|_| Error::CleanupFailed)?,
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
        if !cleanup {
            self.check()?;
        }
        result.map_err(|error| match error {
            deviceforge_tool_process::Error::Cancelled => Error::Cancelled,
            deviceforge_tool_process::Error::Timeout => Error::Timeout,
            deviceforge_tool_process::Error::CleanupFailed { .. } => Error::CleanupFailed,
            other => Error::Tool(other.to_string()),
        })
    }
    pub(crate) async fn pause(&self, duration: Duration) -> Result<()> {
        self.check()?;
        let cancel = self.context.cancellation();
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(self.context.deadline().into()) => Err(Error::Timeout),
            _ = cancel.cancelled() => Err(Error::Cancelled),
            _ = tokio::time::sleep(duration) => self.check(),
        }
    }
    pub(crate) async fn record_tool(
        &self,
        executable: &str,
        args: &[String],
        directory: &Path,
        duration: Duration,
    ) -> Result<()> {
        use deviceforge_tool_process::{StreamOptions, spawn_stream_with_lease};
        self.check()?;
        let deadline: Instant = self.context.deadline().into();
        // 业务期限独立检查；额外两秒只用于 stdin exit 和实际退出确认。
        let mut options = ExecutionOptions::new(deadline + Duration::from_secs(2));
        options.stdout_limit = 1024 * 1024;
        options.stderr_limit = 1024 * 1024;
        let mut command = ToolCommand::new(executable, args);
        command.environment = Environment::Restricted;
        command.directory = Some(directory);
        for key in ["TEMP", "TMP", "TMPDIR"] {
            command
                .env
                .insert(key.into(), directory.as_os_str().to_owned());
        }
        let mut guard = ToolGuard {
            resources: self.resources.clone(),
            confirmed: false,
        };
        let mut process = match spawn_stream_with_lease(
            command,
            StreamOptions::new(options),
            CancellationToken::new(),
            self.resources.clone(),
        )
        .await
        {
            Ok(process) => process,
            Err(error) => {
                guard.confirmed =
                    !matches!(error, deviceforge_tool_process::Error::CleanupFailed { .. });
                return Err(Error::Tool("录制工具无法启动".into()));
            }
        };
        let cancellation = self.context.cancellation();
        let stop_at = Instant::now() + duration;
        let finished_early = loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => break false,
                _ = tokio::time::sleep_until(deadline) => break false,
                _ = tokio::time::sleep_until(stop_at) => break false,
                chunk = process.recv() => if chunk.is_none() { break true; },
            }
        };
        let cleanup_at = self.cleanup_point()?;
        let input = process.input();
        let sent = if finished_early {
            false
        } else {
            tokio::time::timeout_at(cleanup_at, async {
                input.send(b"exit\n").await?;
                input.close().await
            })
            .await
            .is_ok_and(|result| result.is_ok())
        };
        if !sent && !finished_early {
            process.cancel();
        }
        let result = tokio::time::timeout_at(cleanup_at, process.wait())
            .await
            .map_err(|_| Error::CleanupFailed)?;
        guard.confirmed = !matches!(
            result,
            Err(deviceforge_tool_process::Error::CleanupFailed { .. })
        );
        if !guard.confirmed {
            return Err(Error::CleanupFailed);
        }
        let exit = result.map_err(|_| Error::Tool("录制工具退出异常".into()))?;
        self.check()?;
        if finished_early || !sent || !exit.status.success() {
            return Err(Error::Tool("录制未完成规定时长或正常保存".into()));
        }
        // 正常业务内收尾后，后续产物失败清理仍按其实际发生时间计时。
        *self
            .resources
            .cleanup_at
            .lock()
            .map_err(|_| Error::CleanupFailed)? = None;
        Ok(())
    }
    pub(crate) async fn finish(&self, success: bool) -> Result<()> {
        if self.resources.unresolved.load(Ordering::Acquire)
            || Arc::strong_count(&self.resources) != 1
        {
            return Err(Error::CleanupFailed);
        }
        let deadline = self.cleanup_point()?;
        let resources = self.resources.clone();
        let mut guard = ToolGuard {
            resources: self.resources.clone(),
            confirmed: false,
        };
        let mut worker = tokio::task::spawn_blocking(move || {
            let check = || {
                if std::time::Instant::now() >= deadline.into_std() {
                    Err(Error::CleanupFailed)
                } else {
                    Ok(())
                }
            };
            if !success {
                let mut outputs = resources.outputs.lock().map_err(|_| Error::CleanupFailed)?;
                while let Some(path) = outputs.last() {
                    check()?;
                    std::fs::remove_file(path).map_err(|_| Error::CleanupFailed)?;
                    outputs.pop();
                }
            }
            check()?;
            if let Some(directory) = resources
                .directory
                .lock()
                .map_err(|_| Error::CleanupFailed)?
                .take()
            {
                directory.close().map_err(|_| Error::CleanupFailed)?;
            }
            check()
        });
        let result = tokio::time::timeout_at(deadline, &mut worker)
            .await
            .map_err(|_| Error::CleanupFailed)?
            .map_err(|_| Error::CleanupFailed)?;
        guard.confirmed = result.is_ok();
        result
    }
}
