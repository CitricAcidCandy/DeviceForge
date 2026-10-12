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
    pub(crate) fn cleanup_stage_complete(&self) -> Result<()> {
        // 业务尚在原期限内时，远端正常收尾不消耗随后产物交付的清理窗口。
        // 一旦取消或到期则保持同一个清理截止点，不能重新授予两秒。
        if self.context.check().is_ok() && !self.resources.unresolved.load(Ordering::Acquire) {
            *self
                .resources
                .cleanup_at
                .lock()
                .map_err(|_| Error::CleanupFailed)? = None;
        }
        Ok(())
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
                        .prefix("deviceforge-frida-")
                        .tempdir_in(root)
                }
                None => tempfile::Builder::new()
                    .prefix("deviceforge-frida-")
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
    pub(crate) async fn root_shell(
        &self,
        adb: &str,
        device: &str,
        script: &str,
        cleanup: bool,
    ) -> Result<Output> {
        let quoted = script.replace('\'', "'\\''");
        let data = format!("su -c '{quoted}'\n");
        let args = vec!["-s".into(), device.into(), "shell".into(), "sh".into()];
        self.capture(adb, &args, Some(data.as_bytes()), None, cleanup)
            .await
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
