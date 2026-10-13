use super::{ScopedStreamingProcess, lifecycle, ownership::Owner, windows};
use crate::{
    Error, Result, StreamOptions, ToolCommand, command, ownership::Lease, streaming::input,
};
use std::io;
use tokio::sync::{Semaphore, mpsc};
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
    cancel: CancellationToken,
    lease: Option<Lease>,
) -> Result<ScopedStreamingProcess> {
    let permit = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(Error::Cancelled),
        _ = tokio::time::sleep_until(options.execution.deadline) => return Err(Error::Timeout),
        permit = LAUNCH_SLOTS.acquire() => permit.map_err(|error|
            Error::ProcessIo(io::Error::other(error)))?,
    };
    let mut prepared = command::prepare(&command);
    prepared.creation_flags(windows::CREATION_FLAGS);
    let runtime = tokio::runtime::Handle::current();
    let cancel = cancel.child_token();
    let mut guard = LaunchGuard(Some(cancel.clone()));
    let launch_cancel = cancel.clone();
    let owner = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let _entered = runtime.enter();
        crate::lifecycle::preflight(&options.execution, &launch_cancel)?;
        let scope = windows::Scope::new()?;
        let child = prepared.spawn().map_err(Error::Spawn)?;
        let mut owner = Owner::new(child, scope, lease, options.execution.cleanup_timeout);
        crate::lifecycle::preflight(&options.execution, &launch_cancel)?;
        owner.activate(&options.execution, &launch_cancel)?;
        Ok::<_, Error>(owner)
    })
    .await
    .map_err(|error| Error::CleanupFailed {
        cause: Box::new(Error::ProcessIo(io::Error::other(error))),
    })??;
    let (input, input_receiver) = input::channel(options, cancel.clone());
    let (output_sender, output_receiver) = mpsc::channel(options.channel_capacity);
    let handle = tokio::spawn(lifecycle::run(
        owner,
        options,
        cancel.clone(),
        input.revoked(),
        input_receiver,
        output_sender,
    ));
    guard.0.take();
    Ok(ScopedStreamingProcess::new(
        input,
        output_receiver,
        cancel,
        handle,
    ))
}
