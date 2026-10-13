use super::{ScopeCompletion, ScopedStreamExit, ownership::Owner};
use crate::{
    Error, OutputStream, Result, StreamChunk, StreamExit, StreamOptions,
    streaming::{input, output},
    streams,
};
use std::{io, process::ExitStatus, time::Duration};
use tokio::{sync::mpsc, time};
use tokio_util::sync::CancellationToken;

enum Event {
    Output(Result<(u64, u64)>),
    Exit(Result<ExitStatus>),
    Cancel,
    Deadline,
    CleanupDeadline,
    Poll,
}

pub(super) async fn run(
    mut owner: Owner,
    options: StreamOptions,
    cancel: CancellationToken,
    revoked: CancellationToken,
    input_receiver: mpsc::Receiver<input::Message>,
    output_sender: mpsc::Sender<StreamChunk>,
) -> Result<ScopedStreamExit> {
    let (stdin, stdout, stderr) =
        streams::take_pipes(owner.child()).map_err(|error| Error::CleanupFailed {
            cause: Box::new(error),
        })?;
    let input_revoked = revoked.clone();
    let mut io_future = Some(Box::pin(async move {
        let (stdout_bytes, stderr_bytes, ()) = tokio::try_join!(
            output::read(
                stdout,
                output_sender.clone(),
                OutputStream::Stdout,
                options.chunk_size,
                options.execution.stdout_limit
            ),
            output::read(
                stderr,
                output_sender,
                OutputStream::Stderr,
                options.chunk_size,
                options.execution.stderr_limit
            ),
            input::write(stdin, input_receiver, input_revoked),
        )?;
        Ok((stdout_bytes, stderr_bytes))
    }));
    let mut direct_status = None;
    let mut io_result = None;
    let mut failure = None;
    let mut scope_failed = false;
    let mut poll = time::interval(Duration::from_millis(5));
    poll.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    loop {
        let scope_done = match owner.empty() {
            Ok(empty) => empty,
            Err(_) => {
                scope_failed = true;
                if owner.stop().is_err() {
                    scope_failed = true;
                }
                false
            }
        };
        if scope_done && matches!(direct_status, Some(Ok(_))) && io_result.is_some() {
            revoked.cancel();
            io_future.take();
            owner.confirmed();
            return Ok(ScopedStreamExit {
                direct: direct_result(direct_status, io_result, failure),
                scope: if scope_failed {
                    ScopeCompletion::Failed
                } else {
                    ScopeCompletion::Complete
                },
            });
        }
        let cleanup_deadline = owner.deadline();
        let event = tokio::select! {
            biased;
            _ = cancel.cancelled(), if failure.is_none() => Event::Cancel,
            _ = time::sleep_until(options.execution.deadline), if failure.is_none() => Event::Deadline,
            _ = time::sleep_until(cleanup_deadline.unwrap_or(options.execution.deadline)),
                if cleanup_deadline.is_some() => Event::CleanupDeadline,
            status = owner.child().wait(), if direct_status.is_none() =>
                Event::Exit(status.map_err(Error::ProcessIo)),
            result = async { io_future.as_mut().expect("输出工作尚未结束").await },
                if io_future.is_some() => Event::Output(result),
            _ = poll.tick() => Event::Poll,
        };
        let stop = match event {
            Event::Cancel => {
                failure = Some(Error::Cancelled);
                true
            }
            Event::Deadline => {
                failure = Some(Error::Timeout);
                true
            }
            Event::CleanupDeadline => {
                revoked.cancel();
                io_future.take();
                let _ = owner.stop();
                return Ok(ScopedStreamExit {
                    direct: direct_result(direct_status, io_result, failure),
                    scope: ScopeCompletion::Failed,
                });
            }
            Event::Exit(status) => {
                revoked.cancel();
                owner.begin_cleanup();
                let failed = status.is_err();
                direct_status = Some(status);
                failed
            }
            Event::Output(result) => {
                let failed = result.is_err();
                io_future.take();
                io_result = Some(result);
                failed
            }
            Event::Poll => false,
        };
        if stop {
            revoked.cancel();
            if owner.stop().is_err() {
                scope_failed = true;
            }
        }
        if failure.is_some() || matches!(direct_status, Some(Err(_))) {
            io_future.take();
            io_result.get_or_insert_with(|| {
                Err(Error::ProcessIo(io::Error::other("业务终止后管道已撤销")))
            });
        }
    }
}

fn direct_result(
    status: Option<Result<ExitStatus>>,
    output: Option<Result<(u64, u64)>>,
    failure: Option<Error>,
) -> Result<StreamExit> {
    if let Some(error) = failure {
        return Err(error);
    }
    let (stdout_bytes, stderr_bytes) = output
        .ok_or_else(|| Error::ProcessIo(io::Error::other("完整范围收口前输出尚未完成")))??;
    let status =
        status.ok_or_else(|| Error::ProcessIo(io::Error::other("直接进程退出尚未确认")))??;
    Ok(StreamExit {
        status,
        stdout_bytes,
        stderr_bytes,
    })
}
