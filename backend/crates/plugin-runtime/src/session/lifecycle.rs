use super::{SessionInput, SessionOptions, SessionOutput, control, io, pump, state::State};
use crate::{ContextError, Execution, InvocationContext};
use apk_plugin_sdk::session::SessionOpen;
use std::{future::Future, sync::Arc};
use tokio::{
    io::{AsyncBufRead, AsyncWrite},
    time::{Instant, sleep_until},
};

struct DropGuard {
    state: Arc<State>,
    armed: bool,
}

impl Drop for DropGuard {
    fn drop(&mut self) {
        if self.armed {
            self.state.fail("会话运行等待已丢弃，清理尚未确认");
        }
    }
}

/// 控制和传输失败只撤销准入；已启动处理器必须返回真实清理声明。
pub(super) async fn run<R, W, F, Fut>(
    reader: &mut R,
    writer: &mut W,
    open: SessionOpen,
    context: InvocationContext,
    options: SessionOptions,
    handler: F,
) -> Result<(Execution, u64, Option<Instant>), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnOnce(SessionOpen, InvocationContext, SessionInput, SessionOutput) -> Fut,
    Fut: Future<Output = Execution>,
{
    let state = State::new(context.clone());
    let mut guard = DropGuard {
        state: state.clone(),
        armed: true,
    };
    let (input, sender, output, receiver) = io::channels(options, state.clone());
    let id = open.session_id.clone();
    let observer = context.clone();
    let cancel = context.cancellation();
    let deadline = Instant::from_std(context.deadline());
    let work = async move {
        // 首 poll 紧邻业务调用复核，已到期或先收到取消时零业务调用。
        if let Err(error) = context.check() {
            return Execution::complete(Err(error.to_string()));
        }
        handler(open, context, input, output).await
    };
    let controls = control::observe(reader, &id, sender, options, state.clone());
    let outputs = pump::output(
        writer,
        &id,
        receiver,
        state.clone(),
        options.transport_grace,
    );
    tokio::pin!(work, controls, outputs);
    let mut execution = None;
    let mut output_result = None;
    let mut controls_done = false;
    let mut cancellation_seen = false;
    loop {
        if execution.is_some() && output_result.is_some() {
            break;
        }
        tokio::select! {
            biased;
            _ = sleep_until(deadline), if !cancellation_seen => {
                state.fail(ContextError::Timeout.to_string());
                cancellation_seen = true;
            }
            _ = cancel.cancelled(), if !cancellation_seen => {
                let error = if observer.check() == Err(ContextError::Timeout) {
                    ContextError::Timeout
                } else {
                    ContextError::Cancelled
                };
                state.fail(error.to_string());
                cancellation_seen = true;
            }
            () = &mut controls, if !controls_done => {
                controls_done = true;
            }
            result = &mut outputs, if output_result.is_none() => {
                output_result = Some(result);
            }
            result = &mut work, if execution.is_none() => {
                if let Err(error) = observer.check() {
                    state.fail(error.to_string());
                }
                state.close_output();
                execution = Some(result);
            }
        }
    }
    let mut execution = execution.expect("会话处理器已真实结束");
    if let Some(error) = state.failure() {
        execution.outcome = Err(error);
    }
    // 已有真实 Execution；后续终态传输成功与否不改变其 cleanup 字段。
    guard.armed = false;
    let (sequence, completion_deadline) = output_result.expect("会话输出监督已结束")?;
    Ok((execution, sequence, completion_deadline))
}
