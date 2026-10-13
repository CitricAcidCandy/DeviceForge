use crate::{Control, Error, Result, control::Waiting};
use deviceforge_tool_process::{
    Environment, ExecutionOptions, OutputStream, StreamOptions, ToolCommand,
    spawn_stream_with_lease,
};
use std::process::ExitStatus;
use tokio::time;

pub(super) struct Captured {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: ExitStatus,
}

pub(super) async fn run(control: &Control, args: &[String]) -> Result<Captured> {
    control.check()?;
    let mut command = ToolCommand::new(&control.executable, args);
    command.environment = Environment::Restricted;
    let caller = control.context.cancellation();
    let mut waiting = Waiting::new(
        caller.child_token(),
        control.unresolved.clone(),
        &control.lease,
    );
    let mut options = StreamOptions::new(ExecutionOptions::new(control.context.deadline().into()));
    options.input_limit = 0;
    let mut process = match spawn_stream_with_lease(
        command,
        options,
        waiting.stop.clone(),
        control.lease.clone(),
    )
    .await
    {
        Ok(process) => process,
        Err(error) => {
            waiting.confirmed();
            return Err(error.into());
        }
    };
    let _ = process.input().close().await;
    let result = {
        let work = async {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            while let Some(chunk) = process.recv().await {
                match chunk.stream {
                    OutputStream::Stdout => stdout.extend(chunk.bytes),
                    OutputStream::Stderr => stderr.extend(chunk.bytes),
                }
            }
            let exit = process.wait().await?;
            Ok(Captured {
                stdout,
                stderr,
                status: exit.status,
            })
        };
        tokio::pin!(work);
        tokio::select! {
            biased;
            _ = time::sleep_until(control.context.deadline().into()) => {
                waiting.stop.cancel();
                let until = control.lease.cleanup_point()?;
                time::timeout_at(until, &mut work).await.map_err(|_| Error::CleanupFailed)?
            },
            _ = caller.cancelled() => {
                waiting.stop.cancel();
                let until = control.lease.cleanup_point()?;
                time::timeout_at(until, &mut work).await.map_err(|_| Error::CleanupFailed)?
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
    control.check()?;
    result.map_err(Into::into)
}
