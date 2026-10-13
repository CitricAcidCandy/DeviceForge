use super::StreamOptions;
use crate::{Error, Result};
use std::{io, sync::Arc};
use tokio::{
    io::AsyncWriteExt,
    process::ChildStdin,
    sync::{Mutex, mpsc},
    time,
};
use tokio_util::sync::CancellationToken;

/// 输入失败与现有执行错误独立，不改变宿主执行错误的映射。
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InputError {
    #[error("流式输入已关闭")]
    Closed,
    #[error("输入分片超过 {limit} 字节")]
    ChunkTooLarge { limit: usize },
    #[error("累计输入超过 {limit} 字节")]
    InputTooLarge { limit: u64 },
}

pub(crate) enum Message {
    Bytes(Vec<u8>),
    Eof,
}

struct State {
    sender: mpsc::Sender<Message>,
    sent: u64,
    closed: bool,
}

/// 所有克隆共享准入顺序、累计限额及 EOF；成功只表示已入队。
#[derive(Clone)]
pub struct StreamingInput {
    state: Arc<Mutex<State>>,
    revoked: CancellationToken,
    cancel: CancellationToken,
    deadline: time::Instant,
    chunk_size: usize,
    input_limit: u64,
}

pub(crate) fn channel(
    options: StreamOptions,
    cancel: CancellationToken,
) -> (StreamingInput, mpsc::Receiver<Message>) {
    let (sender, receiver) = mpsc::channel(options.channel_capacity);
    let input = StreamingInput {
        state: Arc::new(Mutex::new(State {
            sender,
            sent: 0,
            closed: false,
        })),
        revoked: CancellationToken::new(),
        cancel,
        deadline: options.execution.deadline,
        chunk_size: options.chunk_size,
        input_limit: options.input_limit,
    };
    (input, receiver)
}

impl StreamingInput {
    pub async fn send(&self, bytes: &[u8]) -> std::result::Result<(), InputError> {
        self.admit(Some(bytes)).await
    }

    /// EOF 排在此前已准入的字节之后，重复关闭返回 Closed。
    pub async fn close(&self) -> std::result::Result<(), InputError> {
        self.admit(None).await
    }

    pub(crate) fn revoked(&self) -> CancellationToken {
        self.revoked.clone()
    }

    pub(crate) fn revoke(&self) {
        self.revoked.cancel();
    }

    fn unavailable(&self) -> bool {
        self.revoked.is_cancelled()
            || self.cancel.is_cancelled()
            || time::Instant::now() >= self.deadline
    }

    async fn admit(&self, bytes: Option<&[u8]>) -> std::result::Result<(), InputError> {
        let mut state = tokio::select! {
            biased;
            _ = self.revoked.cancelled() => return Err(InputError::Closed),
            _ = self.cancel.cancelled() => return Err(InputError::Closed),
            _ = time::sleep_until(self.deadline) => return Err(InputError::Closed),
            state = self.state.lock() => state,
        };
        if state.closed || self.unavailable() {
            return Err(InputError::Closed);
        }
        let size = bytes.map_or(0, <[u8]>::len);
        if size > self.chunk_size {
            return Err(InputError::ChunkTooLarge {
                limit: self.chunk_size,
            });
        }
        let total = state
            .sent
            .checked_add(size as u64)
            .filter(|total| *total <= self.input_limit)
            .ok_or(InputError::InputTooLarge {
                limit: self.input_limit,
            })?;
        let sender = state.sender.clone();
        let permit = tokio::select! {
            biased;
            _ = self.revoked.cancelled() => return Err(InputError::Closed),
            _ = self.cancel.cancelled() => return Err(InputError::Closed),
            _ = time::sleep_until(self.deadline) => return Err(InputError::Closed),
            permit = sender.reserve() => permit.map_err(|_| InputError::Closed)?,
        };
        if self.unavailable() {
            return Err(InputError::Closed);
        }
        // 容量准入和终态复核完成后才复制，取消等待不消耗累计限额。
        let message = match bytes {
            Some(bytes) => Message::Bytes(bytes.to_vec()),
            None => {
                state.closed = true;
                Message::Eof
            }
        };
        state.sent = total;
        permit.send(message);
        Ok(())
    }
}

pub(crate) async fn write(
    mut stdin: ChildStdin,
    mut receiver: mpsc::Receiver<Message>,
    revoked: CancellationToken,
) -> Result<()> {
    loop {
        let message = tokio::select! {
            biased;
            _ = revoked.cancelled() => return Ok(()),
            message = receiver.recv() => message,
        };
        let result = match message {
            Some(Message::Bytes(bytes)) => tokio::select! {
                biased;
                _ = revoked.cancelled() => return Ok(()),
                result = stdin.write_all(&bytes) => result,
            },
            Some(Message::Eof) | None => {
                // 关闭句柄交付 EOF，不等待调用方再次提交输入。
                drop(stdin);
                return Ok(());
            }
        };
        if let Err(error) = result {
            revoked.cancel();
            // 工具可以主动结束输入后继续输出，最终退出状态仍由 wait 确认。
            if error.kind() == io::ErrorKind::BrokenPipe {
                return Ok(());
            }
            return Err(Error::ProcessIo(error));
        }
    }
}
