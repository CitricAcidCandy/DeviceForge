use super::{Control, Lease, RemotePhase, Waiting};
use crate::{Error, Result, session::files};
use deviceforge_tool_process::{
    Environment, ExecutionOptions, OutputStream, StreamOptions, ToolCommand,
    spawn_stream_with_lease,
};
use std::{
    future::Future,
    io::Write,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinError, JoinHandle};

pub(crate) struct FileCapture {
    pub stderr: Vec<u8>,
    pub bytes: u64,
}

pub(crate) struct ResourceGuard {
    pub unresolved: Arc<AtomicBool>,
    pub confirmed: bool,
}

impl Drop for ResourceGuard {
    fn drop(&mut self) {
        if !self.confirmed {
            self.unresolved.store(true, Ordering::Release);
        }
    }
}

async fn cleanup_wait<T>(
    lease: &Lease,
    unresolved: &AtomicBool,
    work: impl Future<Output = T>,
) -> Result<T> {
    let until = lease.cleanup_point()?;
    if tokio::time::Instant::now() >= until {
        unresolved.store(true, Ordering::Release);
        return Err(Error::CleanupFailed);
    }
    match tokio::time::timeout_at(until, work).await {
        Ok(result) if tokio::time::Instant::now() < until => Ok(result),
        _ => {
            unresolved.store(true, Ordering::Release);
            Err(Error::CleanupFailed)
        }
    }
}

fn joined_writer(
    lease: &Lease,
    unresolved: &AtomicBool,
    joined: std::result::Result<Result<u64>, JoinError>,
) -> Result<u64> {
    let result = joined.unwrap_or(Err(Error::CleanupFailed));
    if result.is_err() {
        lease.cleanup_point()?;
    }
    if matches!(result, Err(Error::CleanupFailed)) {
        unresolved.store(true, Ordering::Release);
    }
    result
}

async fn close_writer(
    writer: &mut JoinHandle<Result<u64>>,
    lease: &Lease,
    unresolved: &AtomicBool,
    cleaning: bool,
) -> Result<u64> {
    let joined = if cleaning {
        cleanup_wait(lease, unresolved, writer).await?
    } else {
        writer.await
    };
    joined_writer(lease, unresolved, joined)
}

impl Control {
    pub(crate) async fn capture_file(
        &self,
        args: Vec<String>,
        path: PathBuf,
        limit: u64,
    ) -> Result<FileCapture> {
        self.check()?;
        let context = self.context.clone();
        let executable = self.executable.clone();
        let lease = self.lease.clone();
        let unresolved = self.unresolved.clone();
        let stop = context.cancellation().child_token();
        let signal = stop.clone();
        let mut waiting = Waiting::new(stop, self.unresolved.clone(), &self.lease);
        let mut task = tokio::spawn(async move {
            let _lease = lease.clone();
            let caller = context.cancellation();
            let deadline = tokio::time::Instant::from(context.deadline());
            let permit = tokio::select! {
                biased;
                _ = caller.cancelled() => return Err(Error::Cancelled),
                _ = tokio::time::sleep_until(deadline) => return Err(Error::Timeout),
                permit = lease.slots.clone().acquire_owned() => permit.map_err(|_| Error::CleanupFailed)?,
            };
            let (sender, mut receiver) = mpsc::channel::<Vec<u8>>(8);
            let (ready, initialized) = oneshot::channel();
            let writer_lease = lease.clone();
            let writer_stop = signal.clone();
            let task_unresolved = unresolved.clone();
            let mut writer = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let _lease = writer_lease;
                let mut guard = ResourceGuard {
                    unresolved,
                    confirmed: false,
                };
                let mut file = match files::create(&path) {
                    Ok(file) => file,
                    Err(error) => {
                        guard.confirmed = true;
                        let _ = ready.send(false);
                        return Err(error);
                    }
                };
                let _ = ready.send(true);
                let mut count = 0u64;
                let copied = (|| {
                    while let Some(bytes) = receiver.blocking_recv() {
                        if writer_stop.is_cancelled() {
                            return Err(Error::Cancelled);
                        }
                        if tokio::time::Instant::now() >= deadline {
                            return Err(Error::Timeout);
                        }
                        count = count
                            .checked_add(bytes.len() as u64)
                            .filter(|count| *count <= limit)
                            .ok_or(Error::TooLarge)?;
                        file.write_all(&bytes)
                            .map_err(|_| Error::Io("编码帧无法写入"))?;
                    }
                    Ok(count)
                })();
                let flushed = file.flush().map_err(|_| Error::CleanupFailed);
                drop(file);
                guard.confirmed = flushed.is_ok();
                flushed?;
                copied
            });
            let initialized = match initialized.await {
                Ok(initialized) => initialized,
                Err(_) => {
                    lease.cleanup_point()?;
                    task_unresolved.store(true, Ordering::Release);
                    signal.cancel();
                    drop(sender);
                    let _ = close_writer(&mut writer, &lease, &task_unresolved, true).await;
                    return Err(Error::CleanupFailed);
                }
            };
            if !initialized {
                lease.cleanup_point()?;
                drop(sender);
                return close_writer(&mut writer, &lease, &task_unresolved, true)
                    .await
                    .map(|_| FileCapture {
                        stderr: Vec::new(),
                        bytes: 0,
                    });
            }
            let mut command = ToolCommand::new(&executable, &args);
            command.environment = Environment::Restricted;
            let mut execution = ExecutionOptions::new(deadline);
            execution.stdout_limit = limit;
            let options = StreamOptions::new(execution);
            lease.phase(RemotePhase::ReadPending)?;
            let spawned =
                spawn_stream_with_lease(command, options, signal.clone(), lease.clone()).await;
            let mut process = match spawned {
                Ok(process) => process,
                Err(error) => {
                    lease.cleanup_point()?;
                    if matches!(error, deviceforge_tool_process::Error::CleanupFailed { .. }) {
                        task_unresolved.store(true, Ordering::Release);
                    }
                    lease.phase(RemotePhase::Sized)?;
                    drop(sender);
                    close_writer(&mut writer, &lease, &task_unresolved, true).await?;
                    return Err(error.into());
                }
            };
            let mut stderr = Vec::new();
            let mut count = 0u64;
            let mut cause = None;
            let mut written = None;
            loop {
                let chunk = tokio::select! {
                    biased;
                    _ = caller.cancelled() => { cause = Some(Error::Cancelled); break; },
                    _ = tokio::time::sleep_until(deadline) => { cause = Some(Error::Timeout); break; },
                    joined = &mut writer => {
                        written = Some(joined_writer(&lease, &task_unresolved, joined));
                        cause = Some(Error::Io("编码帧写入工作已退出"));
                        break;
                    },
                    chunk = process.recv() => chunk,
                };
                let Some(chunk) = chunk else {
                    break;
                };
                if chunk.stream == OutputStream::Stderr {
                    if stderr.len().saturating_add(chunk.bytes.len()) > 1024 * 1024 {
                        cause = Some(Error::TooLarge);
                        break;
                    }
                    stderr.extend_from_slice(&chunk.bytes);
                } else {
                    count = match count
                        .checked_add(chunk.bytes.len() as u64)
                        .filter(|count| *count <= limit)
                    {
                        Some(count) => count,
                        None => {
                            cause = Some(Error::TooLarge);
                            break;
                        }
                    };
                    let sent = tokio::select! {
                        biased;
                        _ = caller.cancelled() => Err(Error::Cancelled),
                        _ = tokio::time::sleep_until(deadline) => Err(Error::Timeout),
                        result = sender.send(chunk.bytes) => result.map_err(|_| Error::Io("编码帧写入工作已退出")),
                    };
                    if let Err(error) = sent {
                        cause = Some(error);
                        break;
                    }
                }
            }
            let cleaning = cause.is_some();
            if cleaning {
                lease.cleanup_point()?;
                process.cancel();
                signal.cancel();
            }
            drop(sender);
            let exited = if cleaning {
                cleanup_wait(&lease, &task_unresolved, process.wait()).await?
            } else {
                process.wait().await
            };
            let process_failed = match &exited {
                Ok(exit) => {
                    !exit.status.success()
                        || exit.stdout_bytes != count
                        || exit.stderr_bytes != stderr.len() as u64
                }
                Err(_) => true,
            };
            if process_failed {
                lease.cleanup_point()?;
                if matches!(
                    exited,
                    Err(deviceforge_tool_process::Error::CleanupFailed { .. })
                ) {
                    task_unresolved.store(true, Ordering::Release);
                }
            }
            let written = match written {
                Some(result) => result,
                None => {
                    close_writer(
                        &mut writer,
                        &lease,
                        &task_unresolved,
                        cleaning || process_failed,
                    )
                    .await
                }
            };
            let written = written?;
            if let Some(error) = cause {
                return Err(error);
            }
            let exited = exited.map_err(Error::from)?;
            if !exited.status.success() {
                lease.cleanup_point()?;
                return Err(Error::Dependency("HDC客户端执行失败，请检查部署配置"));
            }
            if exited.stdout_bytes != count
                || written != count
                || exited.stderr_bytes != stderr.len() as u64
            {
                lease.cleanup_point()?;
                return Err(Error::Dependency("截图两流接收计数不一致"));
            }
            Ok(FileCapture {
                stderr,
                bytes: count,
            })
        });
        let caller = self.context.cancellation();
        let cause = tokio::select! {
            biased;
            _ = caller.cancelled() => Error::Cancelled,
            _ = tokio::time::sleep_until(self.context.deadline().into()) => Error::Timeout,
            result = &mut task => {
                let result = result.map_err(|_| Error::CleanupFailed)?;
                waiting.confirmed();
                self.check()?;
                return result;
            }
        };
        waiting.stop.cancel();
        let until = self.lease.cleanup_point()?;
        let result = tokio::time::timeout_at(until, task)
            .await
            .map_err(|_| Error::CleanupFailed)?;
        result.map_err(|_| Error::CleanupFailed)??;
        waiting.confirmed();
        Err(cause)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, time::Duration};

    #[tokio::test(start_paused = true)]
    async fn repeated_cleanup_wait_uses_the_first_absolute_point_without_new_budget() {
        let lease = Lease::default();
        let unresolved = AtomicBool::new(false);
        let first = lease.cleanup_point().unwrap();
        tokio::time::advance(Duration::from_millis(1500)).await;
        assert!(matches!(
            cleanup_wait(&lease, &unresolved, std::future::pending::<()>()).await,
            Err(Error::CleanupFailed)
        ));
        assert_eq!(tokio::time::Instant::now(), first);
        assert!(matches!(
            cleanup_wait(&lease, &unresolved, std::future::ready(())).await,
            Err(Error::CleanupFailed)
        ));
        assert_eq!(lease.cleanup_point().unwrap(), first);
        assert!(unresolved.load(Ordering::Acquire));
        assert!(matches!(
            cleanup_wait(&lease, &unresolved, std::future::pending::<()>()).await,
            Err(Error::CleanupFailed)
        ));
        assert_eq!(tokio::time::Instant::now(), first);
    }

    struct Release(std::sync::mpsc::Sender<()>);

    impl Drop for Release {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn exhausted_cleanup_keeps_real_file_worker_lease_and_sticky_failure_until_actual_exit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("blocked.b64");
        let lease = Arc::new(Lease::default());
        let unresolved = Arc::new(AtomicBool::new(false));
        let worker_lease = lease.clone();
        let worker_unresolved = unresolved.clone();
        let worker_path = path.clone();
        let (sender, gate) = std::sync::mpsc::channel();
        let release = Release(sender);
        let (started, observing) = oneshot::channel();
        let mut worker = tokio::task::spawn_blocking(move || {
            let _lease = worker_lease;
            let mut guard = ResourceGuard {
                unresolved: worker_unresolved,
                confirmed: false,
            };
            let mut file = File::create(worker_path).unwrap();
            started.send(()).unwrap();
            gate.recv().unwrap();
            file.flush().unwrap();
            drop(file);
            guard.confirmed = true;
            Ok(0u64)
        });
        observing.await.unwrap();
        assert_eq!(Arc::strong_count(&lease), 2);
        let first = lease.cleanup_point().unwrap();
        {
            let closing = close_writer(&mut worker, &lease, &unresolved, true);
            tokio::pin!(closing);
            tokio::select! {
                biased;
                outcome = &mut closing => panic!("实际文件工作尚未退出，清理应继续等待：{outcome:?}"),
                _ = tokio::task::yield_now() => {},
            }
            tokio::time::advance(first.saturating_duration_since(tokio::time::Instant::now()))
                .await;
            assert!(matches!(closing.await, Err(Error::CleanupFailed)));
        }
        assert_eq!(tokio::time::Instant::now(), first);
        assert_eq!(Arc::strong_count(&lease), 2);
        assert!(unresolved.load(Ordering::Acquire));
        drop(release);
        assert_eq!(worker.await.unwrap().unwrap(), 0);
        assert_eq!(Arc::strong_count(&lease), 1);
        assert_eq!(lease.cleanup_point().unwrap(), first);
        assert!(unresolved.load(Ordering::Acquire));
        std::fs::remove_file(path).unwrap();
    }
}
