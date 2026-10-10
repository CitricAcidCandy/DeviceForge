//! 同一直接进程的有界双向字节流；不解释平台命令或终端协议。
mod input;
mod lifecycle;
mod options;
mod output;
mod session;

pub use input::{InputError, StreamingInput};
pub use options::StreamOptions;
pub use session::{StreamChunk, StreamExit, StreamingProcess};

use crate::ownership::{Lease, Owner};
use crate::{Error, Result, ToolCommand, command};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// 启动后使用输入句柄发送字节；不接受预置的命令输入。
pub async fn spawn_stream(
    command: ToolCommand<'_>,
    options: StreamOptions,
    cancel: CancellationToken,
) -> Result<StreamingProcess> {
    spawn_owned(command, options, cancel, None)
}

/// 租约由后台监督持有，直到直接进程退出得到确认。
pub async fn spawn_stream_with_lease<T: Send + Sync + 'static>(
    command: ToolCommand<'_>,
    options: StreamOptions,
    cancel: CancellationToken,
    lease: Arc<T>,
) -> Result<StreamingProcess> {
    spawn_owned(command, options, cancel, Some(lease))
}

fn spawn_owned(
    command: ToolCommand<'_>,
    options: StreamOptions,
    cancel: CancellationToken,
    lease: Option<Lease>,
) -> Result<StreamingProcess> {
    options.validate()?;
    if command.input.is_some() {
        return Err(Error::InvalidOptions("流式执行须使用运行时输入句柄"));
    }
    crate::lifecycle::preflight(&options.execution, &cancel)?;
    let child = command::prepare(&command).spawn().map_err(Error::Spawn)?;
    let owner = Owner::new(child, lease);
    let cancel = cancel.child_token();
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
    Ok(StreamingProcess::new(
        input,
        output_receiver,
        cancel,
        handle,
    ))
}
