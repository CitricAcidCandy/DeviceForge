//! 协议 5 的独立双向会话入口，不复用普通任务的单次响应路径。
mod control;
mod io;
mod lifecycle;
mod options;
mod pump;
mod state;
mod transport;

pub use io::{SessionInput, SessionIoError, SessionOutput};
pub use options::SessionOptions;

use crate::{Execution, InvocationContext};
use apk_plugin_sdk::session::SessionOpen;
use std::future::Future;
use tokio::io::{AsyncRead, AsyncWrite, BufReader};

pub async fn serve_session<F, Fut>(options: SessionOptions, handler: F) -> Result<(), String>
where
    F: FnOnce(SessionOpen, InvocationContext, SessionInput, SessionOutput) -> Fut,
    Fut: Future<Output = Execution>,
{
    crate::stdio::prepare()?;
    serve_session_io(tokio::io::stdin(), tokio::io::stdout(), options, handler).await
}

/// 握手耗时计入固定业务截止点；取消后仍等待已启动处理器的真实 Execution。
pub async fn serve_session_io<R, W, F, Fut>(
    reader: R,
    mut writer: W,
    options: SessionOptions,
    handler: F,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnOnce(SessionOpen, InvocationContext, SessionInput, SessionOutput) -> Fut,
    Fut: Future<Output = Execution>,
{
    options.validate()?;
    let mut reader = BufReader::new(reader);
    let (open, context) = transport::handshake(&mut reader, &mut writer, options).await?;
    let id = open.session_id.clone();
    let (execution, sequence, completion_deadline) =
        lifecycle::run(&mut reader, &mut writer, open, context, options, handler).await?;
    transport::finished(
        &mut writer,
        id,
        sequence,
        execution,
        options.transport_grace,
        completion_deadline,
    )
    .await
}
