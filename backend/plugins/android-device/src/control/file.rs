use super::{Control, ToolGuard, Waiting};
use crate::{Error, Result, session::FILE_LIMIT};
use deviceforge_tool_process::{
    Environment, ExecutionOptions, ToolCommand, capture_to_file_with_lease,
};
use tokio::io::AsyncWriteExt;

impl Control {
    pub(crate) async fn capture_file(&self, args: Vec<String>, file: std::fs::File) -> Result<()> {
        self.check()?;
        let context = self.context.clone();
        let executable = self.executable.clone();
        let lease = self.lease.clone();
        let signal = context.cancellation().child_token();
        let cancel = signal.clone();
        let unresolved = self.unresolved.clone();
        let waiting = Waiting::new(signal, self.unresolved.clone(), &self.lease);
        let mut task = tokio::spawn(async move {
            let _lease = lease.clone();
            let mut guard = ToolGuard {
                unresolved,
                confirmed: false,
            };
            let mut file = tokio::fs::File::from_std(file);
            let mut command = ToolCommand::new(&executable, &args);
            command.environment = Environment::Restricted;
            let captured = capture_to_file_with_lease(
                command,
                ExecutionOptions::new(context.deadline().into()),
                cancel,
                &mut file,
                FILE_LIMIT,
                lease.clone(),
            )
            .await;
            let flushed = file.flush().await.map_err(|_| Error::CleanupFailed);
            drop(file.into_std().await);
            guard.confirmed = !matches!(
                captured,
                Err(deviceforge_tool_process::Error::CleanupFailed { .. })
            ) && flushed.is_ok();
            if !guard.confirmed {
                return Err(Error::CleanupFailed);
            }
            context.check()?;
            captured.map_err(Into::into)
        });
        self.wait_file(&mut task, waiting).await
    }

    async fn wait_file(
        &self,
        task: &mut tokio::task::JoinHandle<Result<()>>,
        mut waiting: Waiting,
    ) -> Result<()> {
        let caller = self.context.cancellation();
        let cause = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(self.context.deadline().into()) => Error::Timeout,
            _ = caller.cancelled() => Error::Cancelled,
            joined = &mut *task => {
                let result = joined.map_err(|_| Error::CleanupFailed)?;
                waiting.confirmed();
                if matches!(result, Err(Error::CleanupFailed)) { return result; }
                self.check()?;
                return result;
            },
        };
        waiting.stop.cancel();
        let until = self.lease.cleanup_point()?;
        let result = tokio::time::timeout_at(until, task)
            .await
            .map_err(|_| Error::CleanupFailed)?;
        let result = result.map_err(|_| Error::CleanupFailed)?;
        waiting.confirmed();
        if matches!(result, Err(Error::CleanupFailed)) {
            return result;
        }
        Err(self
            .context
            .check()
            .map_err(Error::from)
            .err()
            .unwrap_or(cause))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::lifecycle::{context, poll_pending};
    use std::{
        sync::{Arc, atomic::Ordering},
        time::Duration,
    };
    use tokio::sync::oneshot;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn dropped_file_wait_keeps_task_and_lease_until_real_flush_and_close() {
        let control = Control::new(context().await, "unused-ADB".into());
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("screenshot.png");
        let file = std::fs::File::create(&path).unwrap();
        let lease = control.lease.clone();
        let stop = CancellationToken::new();
        let cancel = stop.clone();
        let unresolved = control.unresolved.clone();
        let (started, ready) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let mut task = tokio::spawn(async move {
            let _lease = lease;
            let mut guard = ToolGuard {
                unresolved,
                confirmed: false,
            };
            let mut file = tokio::fs::File::from_std(file);
            file.write_all("截图字节".as_bytes()).await.unwrap();
            started.send(()).unwrap();
            cancel.cancelled().await;
            gate.await.unwrap();
            file.flush().await.unwrap();
            drop(file.into_std().await);
            guard.confirmed = true;
            Ok(())
        });
        let waiting = Waiting::new(stop.clone(), control.unresolved.clone(), &control.lease);
        let mut pending = Box::pin(control.wait_file(&mut task, waiting));
        poll_pending(pending.as_mut()).await;
        tokio::time::timeout(Duration::from_secs(1), ready)
            .await
            .unwrap()
            .unwrap();
        drop(pending);
        assert!(stop.is_cancelled());
        assert!(control.unresolved.load(Ordering::Acquire));
        assert_eq!(Arc::strong_count(&control.lease), 2);
        assert!(!task.is_finished());
        release.send(()).unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(Arc::strong_count(&control.lease), 1);
        assert_eq!(std::fs::read(&path).unwrap(), "截图字节".as_bytes());
        assert!(control.unresolved.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn file_task_panic_marks_cleanup_failed_and_keeps_owned_path() {
        let control = Control::new(context().await, "unused-ADB".into());
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("screenshot.png");
        let file = std::fs::File::create(&path).unwrap();
        let lease = control.lease.clone();
        let unresolved = control.unresolved.clone();
        let mut task: tokio::task::JoinHandle<Result<()>> = tokio::spawn(async move {
            let _lease = lease;
            let _file = tokio::fs::File::from_std(file);
            let _guard = ToolGuard {
                unresolved,
                confirmed: false,
            };
            panic!("预期截图文件任务异常");
        });
        let waiting = Waiting::new(
            CancellationToken::new(),
            control.unresolved.clone(),
            &control.lease,
        );
        let result = control.wait_file(&mut task, waiting).await;
        assert!(matches!(result, Err(Error::CleanupFailed)));
        assert!(control.unresolved.load(Ordering::Acquire));
        assert_eq!(Arc::strong_count(&control.lease), 1);
        assert!(path.exists());
    }
}
