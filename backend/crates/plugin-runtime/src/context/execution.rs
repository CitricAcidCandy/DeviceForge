//! 业务调用准入、期限竞争及真实清理等待；不丢弃已启动处理器。
use super::{ContextError, InvocationContext};
use crate::{Execution, framing};
use apk_plugin_sdk::{
    Request,
    context::CONTEXT_PROTOCOL_VERSION,
    cooperative::{CONTROL_LIMIT, CancelReason, ControlFrame},
};
use std::future::Future;
use tokio::{
    io::AsyncBufRead,
    time::{Instant, sleep_until},
};

pub(super) async fn run<R, F, Fut>(
    reader: &mut R,
    request: Request,
    context: InvocationContext,
    handler: F,
) -> Execution
where
    R: AsyncBufRead + Unpin,
    F: FnOnce(Request, InvocationContext) -> Fut,
    Fut: Future<Output = Execution>,
{
    if let Err(error) = context.check() {
        context.cancellation().cancel();
        return Execution::complete(Err(error.to_string()));
    }
    let id = request.request_id.clone();
    let observer = context.clone();
    let cancel = observer.cancellation();
    let deadline = Instant::from_std(observer.deadline());
    let work = async move {
        // 首次 poll 紧邻业务调用复核；握手后收到控制时不得启动新副作用。
        if let Err(error) = context.check() {
            return Execution::complete(Err(error.to_string()));
        }
        handler(request, context).await
    };
    tokio::pin!(work);
    let error = tokio::select! {
        biased;
        _ = sleep_until(deadline) => ContextError::Timeout.to_string(),
        signal = control(reader, &id) => {
            if observer.check() == Err(ContextError::Timeout) {
                ContextError::Timeout.to_string()
            } else {
                signal
            }
        },
        _ = cancel.cancelled() => {
            if observer.check() == Err(ContextError::Timeout) {
                ContextError::Timeout.to_string()
            } else {
                ContextError::Cancelled.to_string()
            }
        },
        mut execution = &mut work => {
            // 即使处理器先报告成功，已经超过同一截止点也不能发布晚结果。
            if let Err(error) = observer.check() {
                cancel.cancel();
                execution.outcome = Err(error.to_string());
            }
            return execution;
        },
    };
    cancel.cancel();
    let mut execution = work.await;
    execution.outcome = Err(error);
    // 原样保留处理器的 complete/failed，不因收到信号或返回而改写清理证据。
    execution
}

async fn control<R: AsyncBufRead + Unpin>(reader: &mut R, id: &str) -> String {
    let bytes = match framing::line(reader, CONTROL_LIMIT).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return ContextError::Cancelled.to_string(),
        Err(error) => return error,
    };
    let frame: ControlFrame = match serde_json::from_slice(&bytes) {
        Ok(frame) => frame,
        Err(_) => return "控制帧无效".into(),
    };
    if frame.protocol_version != CONTEXT_PROTOCOL_VERSION || frame.request_id != id {
        return "控制帧版本或请求 ID 不匹配".into();
    }
    // Start 只在握手阶段出现；此处严格按旧取消形状解析，重复 Start 无法续期。
    match frame.reason {
        CancelReason::Timeout => ContextError::Timeout.to_string(),
        CancelReason::Cancelled => ContextError::Cancelled.to_string(),
        CancelReason::TransportFailure => "宿主传输失败".into(),
    }
}
