//! 协议 4 的本地固定期限、取消信号及加法运行入口。
mod execution;
mod transport;

use crate::Execution;
use apk_plugin_sdk::Request;
use std::{fmt, future::Future, time::Duration};
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextError {
    Timeout,
    Cancelled,
}

impl fmt::Display for ContextError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Timeout => "插件执行期限已到期",
            Self::Cancelled => "操作已取消或宿主连接已关闭",
        })
    }
}

impl std::error::Error for ContextError {}

#[derive(Clone, Debug)]
pub struct InvocationContext {
    deadline: Instant,
    cancellation: CancellationToken,
}

impl InvocationContext {
    pub fn deadline(&self) -> std::time::Instant {
        self.deadline.into_std()
    }

    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    /// 同时到期和取消时报告到期，不在检查时重新授予预算。
    pub fn check(&self) -> Result<(), ContextError> {
        if Instant::now() >= self.deadline {
            return Err(ContextError::Timeout);
        }
        if self.cancellation.is_cancelled() {
            return Err(ContextError::Cancelled);
        }
        Ok(())
    }

    pub(crate) fn from_start(origin: Instant, remaining_timeout_ns: u64) -> Result<Self, String> {
        let deadline = origin
            .checked_add(Duration::from_nanos(remaining_timeout_ns))
            .ok_or("本地执行期限无法表示")?;
        Ok(Self {
            deadline,
            cancellation: CancellationToken::new(),
        })
    }
}

pub async fn serve_once_with_context<F, Fut>(handler: F) -> Result<(), String>
where
    F: FnOnce(Request, InvocationContext) -> Fut,
    Fut: Future<Output = Execution>,
{
    serve_io_with_context(tokio::io::stdin(), tokio::io::stdout(), handler).await
}

/// 两帧握手后才调用处理器；旧 serve_io 保持协议 3 的原签名。
pub async fn serve_io_with_context<R, W, F, Fut>(
    reader: R,
    mut writer: W,
    handler: F,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnOnce(Request, InvocationContext) -> Fut,
    Fut: Future<Output = Execution>,
{
    let mut reader = BufReader::new(reader);
    let (request, context) = transport::handshake(&mut reader, &mut writer).await?;
    let id = request.request_id.clone();
    let execution = execution::run(&mut reader, request, context, handler).await;
    transport::reply(&mut writer, id, execution).await
}
