use super::{
    io::Chunk,
    state::State,
    transport::{self, Written},
};
use apk_plugin_sdk::session::SessionEvent;
use std::sync::Arc;
use std::time::Duration;
use tokio::{
    io::AsyncWrite,
    sync::mpsc,
    time::{Instant, sleep_until},
};

/// 输出正常结束排空准入队列，取消则丢弃尚未发送的块。
pub(super) async fn output<W: AsyncWrite + Unpin>(
    writer: &mut W,
    id: &str,
    mut receiver: mpsc::Receiver<Chunk>,
    state: Arc<State>,
    grace: Duration,
) -> Result<(u64, Option<Instant>), String> {
    let cancel = state.context.cancellation();
    let deadline = Instant::from_std(state.context.deadline());
    let mut closing = false;
    let mut sequence = 1u64;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = sleep_until(deadline) => {
                state.fail(crate::ContextError::Timeout.to_string());
                return Ok((sequence, None));
            }
            _ = cancel.cancelled() => return Ok((sequence, None)),
            _ = state.output_closed.cancelled(), if !closing => {
                closing = true;
                receiver.close();
                continue;
            }
            chunk = receiver.recv() => chunk,
        };
        let Some(chunk) = chunk else {
            return Ok((sequence, None));
        };
        let event = SessionEvent::output(id, sequence, chunk.stream, chunk.bytes);
        match transport::output(writer, &event, &state, grace).await {
            Ok(Written::Complete(completion_deadline)) => {
                let Some(next) = sequence.checked_add(1) else {
                    state.fail("会话输出序号耗尽");
                    return Err("会话输出序号耗尽".into());
                };
                sequence = next;
                if completion_deadline.is_some() {
                    return Ok((sequence, completion_deadline));
                }
            }
            Ok(Written::Abandoned) => return Ok((sequence, None)),
            Err(error) => {
                state.fail(error.clone());
                return Err(error);
            }
        }
    }
}
