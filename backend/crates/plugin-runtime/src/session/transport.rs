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
    Complete,
    Abandoned,
}

/// 半帧已写出后无法安全追加终态；零字节中断才可丢弃该输出帧。
pub(super) async fn output<W: AsyncWrite + Unpin>(
    writer: &mut W,
    event: &SessionEvent,
    state: &State,
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
                return interrupted(offset);
            }
            _ = cancel.cancelled() => return interrupted(offset),
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
            interrupted(offset)
        }
        _ = cancel.cancelled() => interrupted(offset),
        result = writer.flush() => result.map(|()| Written::Complete)
            .map_err(|_| "会话输出刷新失败".into()),
    }
}

fn interrupted(offset: usize) -> Result<Written, String> {
    if offset == 0 {
        Ok(Written::Abandoned)
    } else {
        Err("会话输出帧部分写入后中断，无法安全发送终态".into())
    }
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
    // 真实处理器已结束；此宽限只用于传输确认，不延长业务或清理期限。
    time::timeout(grace, async {
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
