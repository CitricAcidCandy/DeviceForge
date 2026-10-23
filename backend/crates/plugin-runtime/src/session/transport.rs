use super::{SessionOptions, state::State};
use crate::{Execution, InvocationContext, framing};
use apk_plugin_sdk::session::{
    SESSION_FINISH_LIMIT, SESSION_FRAME_LIMIT, SESSION_HANDSHAKE_LIMIT, SESSION_OPEN_LIMIT,
    SessionEvent, SessionOpen, SessionOutcome, SessionReady, SessionStart,
};
use std::{io, time::Duration};
use tokio::{
    io::{AsyncBufRead, AsyncWrite, AsyncWriteExt},
    time::{self, Instant},
};

pub(super) async fn handshake<R, W>(
    reader: &mut R,
    writer: &mut W,
    options: SessionOptions,
) -> Result<(SessionOpen, InvocationContext), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    time::timeout(options.handshake_timeout, async {
        let bytes = framing::line(reader, SESSION_OPEN_LIMIT)
            .await?
            .ok_or("缺少会话Open帧")?;
        let open: SessionOpen = serde_json::from_slice(&bytes).map_err(|_| "会话Open帧无效")?;
        open.validate().map_err(str::to_owned)?;
        // C0 在 Ready 写出前固定，握手等待不重新授予业务预算。
        let origin = Instant::now();
        let ready = SessionReady::new(open.session_id.clone());
        let mut bytes = serde_json::to_vec(&ready).map_err(|_| "会话Ready序列化失败")?;
        if bytes.len() >= SESSION_HANDSHAKE_LIMIT {
            return Err("会话Ready超过握手帧上限".into());
        }
        bytes.push(b'\n');
        writer
            .write_all(&bytes)
            .await
            .map_err(|_| "会话Ready写入失败")?;
        writer.flush().await.map_err(|_| "会话Ready刷新失败")?;
        let bytes = framing::line(reader, SESSION_HANDSHAKE_LIMIT)
            .await?
            .ok_or("缺少会话Start帧")?;
        let start: SessionStart = serde_json::from_slice(&bytes).map_err(|_| "会话Start帧无效")?;
        start.validate().map_err(str::to_owned)?;
        if start.session_id != open.session_id {
            return Err("会话Start的ID不匹配".into());
        }
        let context = InvocationContext::from_start(origin, start.remaining_timeout_ns)?;
        Ok::<_, String>((open, context))
    })
    .await
    .map_err(|_| "会话握手超过传输期限".to_owned())?
}

pub(super) enum Written {
    Complete(Option<Instant>),
    Abandoned,
}

/// 取消后仅补完已经开始的当前帧，后续终态共享首次固定的传输截止点。
pub(super) async fn output<W: AsyncWrite + Unpin>(
    writer: &mut W,
    event: &SessionEvent,
    state: &State,
    grace: Duration,
) -> Result<Written, String> {
    event.validate().map_err(str::to_owned)?;
    let bytes = encode(event, SESSION_FRAME_LIMIT)?;
    let cancel = state.context.cancellation();
    let deadline = Instant::from_std(state.context.deadline());
    let mut offset = 0;
    while offset < bytes.len() {
        let count = tokio::select! {
            biased;
            _ = time::sleep_until(deadline) => {
                state.fail(crate::ContextError::Timeout.to_string());
                return interrupted(writer, &bytes, offset, grace).await;
            }
            _ = cancel.cancelled() => return interrupted(writer, &bytes, offset, grace).await,
            result = writer.write(&bytes[offset..]) => result.map_err(|_| "会话输出写入失败")?,
        };
        if count == 0 {
            return Err("会话输出写入零字节".into());
        }
        offset += count;
    }
    tokio::select! {
        biased;
        _ = time::sleep_until(deadline) => {
            state.fail(crate::ContextError::Timeout.to_string());
            interrupted(writer, &bytes, offset, grace).await
        }
        _ = cancel.cancelled() => interrupted(writer, &bytes, offset, grace).await,
        result = writer.flush() => result.map(|()| Written::Complete(None))
            .map_err(|_| "会话输出刷新失败".into()),
    }
}

async fn interrupted<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
    offset: usize,
    grace: Duration,
) -> Result<Written, String> {
    if offset == 0 {
        return Ok(Written::Abandoned);
    }
    let until = Instant::now() + grace;
    time::timeout_at(until, async {
        writer
            .write_all(&bytes[offset..])
            .await
            .map_err(|_| "会话在途帧补全失败")?;
        writer.flush().await.map_err(|_| "会话在途帧刷新失败")
    })
    .await
    .map_err(|_| "会话输出帧部分写入后在宽限内未完成，无法安全发送终态".to_owned())?
    .map_err(str::to_owned)?;
    Ok(Written::Complete(Some(until)))
}

// JSON 序列化本身也受帧上限约束，不先分配任意大的业务结果。
struct Buffer {
    bytes: Vec<u8>,
    limit: usize,
}

impl io::Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("会话序列化超过帧上限"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encode(event: &SessionEvent, limit: usize) -> Result<Vec<u8>, String> {
    let mut buffer = Buffer {
        bytes: Vec::new(),
        limit: limit - 1,
    };
    serde_json::to_writer(&mut buffer, event).map_err(|_| "会话事件序列化超过帧上限")?;
    buffer.bytes.push(b'\n');
    Ok(buffer.bytes)
}

pub(super) async fn finished<W: AsyncWrite + Unpin>(
    writer: &mut W,
    id: String,
    sequence: u64,
    execution: Execution,
    grace: Duration,
    completion_deadline: Option<Instant>,
) -> Result<(), String> {
    let outcome = match execution.outcome {
        Ok(output) => SessionOutcome {
            result: Some(output.value),
            error: None,
            outputs: output.artifacts,
            cleanup: execution.cleanup,
        },
        Err(error) => SessionOutcome {
            result: None,
            error: Some(normalize_error(error)),
            outputs: Vec::new(),
            cleanup: execution.cleanup,
        },
    };
    let mut event = SessionEvent::finished(id, sequence, outcome);
    event.validate().map_err(str::to_owned)?;
    let bytes = match encode(&event, SESSION_FINISH_LIMIT) {
        Ok(bytes) => bytes,
        Err(_) => {
            if let SessionEvent::Finished { outcome, .. } = &mut event {
                outcome.result = None;
                outcome.error = Some("会话终态超过1 MiB".into());
                outcome.outputs.clear();
            }
            encode(&event, SESSION_FINISH_LIMIT)?
        }
    };
    // 补完过在途帧时不能再次授时；处理器过晚返回也不发送超期终态。
    let until = completion_deadline.unwrap_or_else(|| Instant::now() + grace);
    if Instant::now() >= until {
        return Err("会话终态传输超过宽限".into());
    }
    time::timeout_at(until, async {
        writer
            .write_all(&bytes)
            .await
            .map_err(|_| "会话终态写入失败")?;
        writer.flush().await.map_err(|_| "会话终态刷新失败")?;
        writer
            .shutdown()
            .await
            .map_err(|_| "会话终态流关闭失败".to_owned())
    })
    .await
    .map_err(|_| "会话终态传输超过宽限".to_owned())?
}

fn normalize_error(mut error: String) -> String {
    if error.trim().is_empty() {
        return "插件会话执行失败".into();
    }
    if error.len() > 4096 {
        let mut length = 4096;
        while !error.is_char_boundary(length) {
            length -= 1;
        }
        error.truncate(length);
        if error.trim().is_empty() {
            return "插件会话错误超过4096字节".into();
        }
    }
    error
}

#[cfg(test)]
mod tests;
