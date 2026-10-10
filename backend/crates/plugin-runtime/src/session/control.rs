use super::{SessionIoError, SessionOptions, state::State};
use crate::{ContextError, framing};
use apk_plugin_sdk::{
    cooperative::CancelReason,
    session::{SESSION_FRAME_LIMIT, SessionControl},
};
use std::sync::Arc;
use tokio::{io::AsyncBufRead, sync::mpsc};

/// 输入使用 try_send，满队列不阻塞后续取消帧的读取。
pub(super) async fn observe<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    id: &str,
    sender: mpsc::Sender<Vec<u8>>,
    options: SessionOptions,
    state: Arc<State>,
) {
    let mut sender = Some(sender);
    let mut input_eof = false;
    let mut total = 0u64;
    loop {
        let bytes = match framing::line(reader, SESSION_FRAME_LIMIT).await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                state.fail("宿主会话连接已关闭");
                return;
            }
            Err(error) => {
                state.fail(error);
                return;
            }
        };
        let frame: SessionControl = match serde_json::from_slice(&bytes) {
            Ok(frame) => frame,
            Err(_) => {
                state.fail("会话控制帧不符合公开协议");
                return;
            }
        };
        if let Err(error) = frame.validate() {
            state.fail(error);
            return;
        }
        if frame.session_id() != id {
            state.fail("会话控制帧ID不匹配");
            return;
        }
        match frame {
            SessionControl::Cancel { reason, .. } => {
                let error = match reason {
                    CancelReason::Timeout => ContextError::Timeout.to_string(),
                    CancelReason::Cancelled => ContextError::Cancelled.to_string(),
                    CancelReason::TransportFailure => "宿主会话传输失败".into(),
                };
                state.fail(error);
                sender.take();
                // 已撤销业务也继续观察控制，直到真实处理器完成。
            }
            SessionControl::Eof { .. } => {
                if input_eof {
                    state.fail("会话输入EOF不得重复");
                }
                input_eof = true;
                sender.take();
            }
            SessionControl::Input { bytes, .. } => {
                if input_eof {
                    state.fail("会话输入EOF之后不得发送字节");
                    continue;
                }
                if state.check().is_err() {
                    sender.take();
                    continue;
                }
                let next = total
                    .checked_add(bytes.len() as u64)
                    .filter(|next| *next <= options.input_limit);
                let Some(next) = next else {
                    state.fail(
                        SessionIoError::InputTooLarge {
                            limit: options.input_limit,
                        }
                        .to_string(),
                    );
                    sender.take();
                    continue;
                };
                let Some(input) = &sender else {
                    continue;
                };
                match input.try_send(bytes) {
                    Ok(()) => total = next,
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        state.fail(SessionIoError::InputQueueFull.to_string());
                        sender.take();
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        state.fail("会话业务输入已关闭");
                        sender.take();
                    }
                }
            }
        }
    }
}
