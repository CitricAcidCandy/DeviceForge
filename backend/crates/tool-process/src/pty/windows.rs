mod launch;
mod lifecycle;
mod native;

use super::{PtyProcess, PtySize, input};
use crate::{Error, Result, StreamOptions, ToolCommand, ownership::Lease};
use tokio::sync::{Semaphore, SemaphorePermit, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

static LAUNCH_SLOTS: Semaphore = Semaphore::const_new(4);

struct LaunchGuard(Option<CancellationToken>);
impl Drop for LaunchGuard {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            cancel.cancel();
        }
    }
}

pub(super) async fn spawn(
    command: ToolCommand<'_>,
    options: StreamOptions,
    size: PtySize,
    cancel: CancellationToken,
    lease: Lease,
) -> Result<PtyProcess> {
    let permit = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(crate::Error::Cancelled),
        _ = tokio::time::sleep_until(options.execution.deadline) => return Err(crate::Error::Timeout),
        permit = LAUNCH_SLOTS.acquire() => permit.map_err(|_| crate::Error::InvalidOptions("终端启动工作池已关闭"))?,
    };
    let spec = launch::Specification::new(command)?;
    let cancel = cancel.child_token();
    let mut guard = LaunchGuard(Some(cancel.clone()));
    let worker_cancel = cancel.clone();
    let (ready, mut receive) = oneshot::channel();
    // 启动Future被丢弃后仍保留租约和受限工作槽，结果由监督器完整接收。
    tokio::spawn(async move {
        let result = launch_owned(spec, options, size, worker_cancel, lease, permit).await;
        let _ = ready.send(result);
    });
    let interrupted = tokio::select! {
        biased;
        _ = cancel.cancelled() => Error::Cancelled,
        _ = tokio::time::sleep_until(options.execution.deadline) => Error::Timeout,
        result = &mut receive => {
            // Future可能在期限到达期间暂停；即使接收分支同时就绪，也要以交接瞬间的
            // 取消和截止状态为准，不能把已经过期的PTY发布成可用资源。
            if let Err(cause) = crate::lifecycle::preflight(&options.execution, &cancel) {
                let result = interrupted_start(std::future::ready(result), &cancel, options, cause).await;
                guard.0.take();
                return result;
            }
            // 成功交接后，监督任务拥有取消与资源回收责任。
            guard.0.take();
            return launch_result(result);
        },
    };
    // 取消不能提前发布终态：启动监督器仍可能拥有PTY、暂停进程和调用方租约。
    // 直接丢弃本Future时仍由LaunchGuard及独立监督器继续回收。
    let result = interrupted_start(receive, &cancel, options, interrupted).await;
    guard.0.take();
    result
}

fn launch_result(
    result: std::result::Result<Result<PtyProcess>, oneshot::error::RecvError>,
) -> Result<PtyProcess> {
    result.map_err(|error| Error::CleanupFailed {
        cause: Box::new(Error::ProcessIo(std::io::Error::other(error))),
    })?
}

async fn interrupted_start(
    ready: impl std::future::Future<
        Output = std::result::Result<Result<PtyProcess>, oneshot::error::RecvError>,
    >,
    cancel: &CancellationToken,
    options: StreamOptions,
    cause: Error,
) -> Result<PtyProcess> {
    cancel.cancel();
    let confirmation = tokio::time::timeout(options.execution.cleanup_timeout, async {
        let mut process = launch_result(ready.await)?;
        process.cancel();
        process.wait().await
    })
    .await;
    match confirmation {
        // 普通启动/执行错误返回前已经确认清理，外层保留先发生的取消或期限原因。
        Ok(Err(error @ Error::CleanupFailed { .. })) => Err(error),
        Ok(_) => Err(cause),
        // 超时会丢弃已取得的PtyProcess并触发其取消；未交接结果仍由监督器接收。
        Err(_) => Err(Error::CleanupFailed {
            cause: Box::new(cause),
        }),
    }
}

async fn launch_owned(
    spec: launch::Specification,
    options: StreamOptions,
    size: PtySize,
    cancel: CancellationToken,
    lease: Lease,
    permit: SemaphorePermit<'static>,
) -> Result<PtyProcess> {
    crate::lifecycle::preflight(&options.execution, &cancel)?;
    let endpoints = launch::Endpoints::new().await?;
    let worker_cancel = cancel.clone();
    let (owner, pipes, failure) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crate::lifecycle::preflight(&options.execution, &worker_cancel)?;
        endpoints.launch(spec, size, lease, &options.execution, &worker_cancel)
    })
    .await
    .map_err(|error| Error::CleanupFailed {
        cause: Box::new(Error::ProcessIo(std::io::Error::other(error))),
    })??;
    // 会话结束只关闭会话自身，不能反向抢占启动结果的错误原因。
    let session_cancel = cancel.child_token();
    let (input, receiver) = input::channel(options, session_cancel.clone());
    let (sender, output) = mpsc::channel(options.channel_capacity);
    let failed = failure.is_some();
    let handle = tokio::spawn(lifecycle::run(
        (owner, failure),
        pipes,
        options,
        session_cancel.clone(),
        receiver,
        sender,
    ));
    let mut process = PtyProcess::new(input, output, session_cancel, handle);
    if failed {
        return match process.wait().await {
            Err(error) => Err(error),
            Ok(_) => Err(Error::InvalidOptions("终端启动失败缺失原因")),
        };
    }
    Ok(process)
}
