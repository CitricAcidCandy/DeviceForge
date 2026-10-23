#[cfg(windows)]
mod launch;
#[cfg(windows)]
mod lifecycle;
#[cfg(windows)]
mod ownership;
mod session;
#[cfg(windows)]
pub(crate) mod windows;

pub use session::ScopedStreamingProcess;

use crate::{Result, StreamExit, StreamOptions, ToolCommand};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopePolicy {
    OwnedTree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeCompletion {
    Complete,
    Failed,
}

#[derive(Debug)]
pub struct ScopedStreamExit {
    pub direct: Result<StreamExit>,
    pub scope: ScopeCompletion,
}

pub async fn spawn_scoped_stream(
    command: ToolCommand<'_>,
    options: StreamOptions,
    cancel: CancellationToken,
    policy: ScopePolicy,
) -> Result<ScopedStreamingProcess> {
    spawn_owned(command, options, cancel, policy, None).await
}

pub async fn spawn_scoped_stream_with_lease<T: Send + Sync + 'static>(
    command: ToolCommand<'_>,
    options: StreamOptions,
    cancel: CancellationToken,
    policy: ScopePolicy,
    lease: Arc<T>,
) -> Result<ScopedStreamingProcess> {
    spawn_owned(command, options, cancel, policy, Some(lease)).await
}

async fn spawn_owned(
    command: ToolCommand<'_>,
    options: StreamOptions,
    cancel: CancellationToken,
    policy: ScopePolicy,
    lease: Option<crate::ownership::Lease>,
) -> Result<ScopedStreamingProcess> {
    options.validate()?;
    if command.input.is_some() {
        return Err(crate::Error::InvalidOptions("流式执行须使用运行时输入句柄"));
    }
    crate::lifecycle::preflight(&options.execution, &cancel)?;
    let ScopePolicy::OwnedTree = policy;
    #[cfg(windows)]
    {
        launch::spawn(command, options, cancel, lease).await
    }
    #[cfg(not(windows))]
    {
        let _ = (command, lease);
        Err(crate::Error::InvalidOptions(
            "本平台完整进程树监督尚未取得运行资格",
        ))
    }
}
