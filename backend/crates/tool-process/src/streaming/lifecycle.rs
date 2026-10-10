use super::{StreamChunk, StreamExit, StreamOptions, input, output};
use crate::ownership::Owner;
use crate::{Error, OutputStream, Result, streams};
use tokio::{sync::mpsc, time};
use tokio_util::sync::CancellationToken;

/// 后台持有真实进程和租约；取消业务不丢弃直接进程的清理等待。
pub(super) async fn run(
    mut owner: Owner,
    options: StreamOptions,
    cancel: CancellationToken,
    revoked: CancellationToken,
    input_receiver: mpsc::Receiver<input::Message>,
    output_sender: mpsc::Sender<StreamChunk>,
) -> Result<StreamExit> {
    let work = async {
        let (stdin, stdout, stderr) = streams::take_pipes(owner.child())?;
        let (stdout_bytes, stderr_bytes, (), status) = tokio::try_join!(
            output::read(
                stdout,
                output_sender.clone(),
                OutputStream::Stdout,
                options.chunk_size,
                options.execution.stdout_limit,
            ),
            output::read(
                stderr,
                output_sender,
                OutputStream::Stderr,
                options.chunk_size,
                options.execution.stderr_limit,
            ),
            input::write(stdin, input_receiver, revoked.clone()),
            async {
                let status = owner.child().wait().await.map_err(Error::ProcessIo);
                // 直接进程退出立即撤销所有输入，不要求用户先交付 EOF。
                revoked.cancel();
                status
            },
        )?;
        Ok(StreamExit {
            status,
            stdout_bytes,
            stderr_bytes,
        })
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::Cancelled),
        _ = time::sleep_until(options.execution.deadline) => Err(Error::Timeout),
        result = work => result,
    };
    revoked.cancel();
    let result = crate::lifecycle::finish(owner.child(), result, &options.execution).await;
    if !matches!(result, Err(Error::CleanupFailed { .. })) {
        owner.confirmed();
    }
    result
}
