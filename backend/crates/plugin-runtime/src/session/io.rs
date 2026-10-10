use super::{SessionOptions, state::State};
use apk_plugin_sdk::session::{SESSION_CHUNK_LIMIT, SessionStream};
use std::{fmt, sync::Arc};
use tokio::{
    sync::{Mutex, mpsc},
    time::{Instant, sleep_until},
};

/// 会话字节准入错误；不携带输入内容或工具诊断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionIoError {
    Closed,
    Cancelled,
    Timeout,
    ChunkTooLarge { limit: usize },
    InputTooLarge { limit: u64 },
    OutputTooLarge { limit: u64 },
    InputQueueFull,
}

impl fmt::Display for SessionIoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => formatter.write_str("会话I/O已关闭"),
            Self::Cancelled => formatter.write_str("会话已取消"),
            Self::Timeout => formatter.write_str("会话业务期限已到期"),
            Self::ChunkTooLarge { limit } => write!(formatter, "会话字节块超过{limit}字节"),
            Self::InputTooLarge { limit } => write!(formatter, "会话累计输入超过{limit}字节"),
            Self::OutputTooLarge { limit } => write!(formatter, "会话累计输出超过{limit}字节"),
            Self::InputQueueFull => formatter.write_str("会话输入队列已满"),
        }
    }
}

impl std::error::Error for SessionIoError {}

pub struct SessionInput {
    receiver: mpsc::Receiver<Vec<u8>>,
    state: Arc<State>,
}

impl SessionInput {
    /// 空块为 Some(Vec::new())；只有收到公开 EOF 才结束输入。
    pub async fn recv(&mut self) -> Result<Option<Vec<u8>>, SessionIoError> {
        self.state.check()?;
        let cancel = self.state.context.cancellation();
        let result = tokio::select! {
            biased;
            _ = sleep_until(Instant::from_std(self.state.context.deadline())) => {
                self.state.fail(crate::ContextError::Timeout.to_string());
                return Err(SessionIoError::Timeout);
            }
            _ = cancel.cancelled() => return Err(SessionIoError::Cancelled),
            result = self.receiver.recv() => result,
        };
        self.state.check()?;
        Ok(result)
    }
}

pub(super) struct Chunk {
    pub stream: SessionStream,
    pub bytes: Vec<u8>,
}

struct OutputState {
    sender: mpsc::Sender<Chunk>,
    total: u64,
}

/// 输出克隆共享累计限额与队列准入顺序，成功仅表示有界入队。
#[derive(Clone)]
pub struct SessionOutput {
    output: Arc<Mutex<OutputState>>,
    state: Arc<State>,
    limit: u64,
}

pub(super) fn channels(
    options: SessionOptions,
    state: Arc<State>,
) -> (
    SessionInput,
    mpsc::Sender<Vec<u8>>,
    SessionOutput,
    mpsc::Receiver<Chunk>,
) {
    let (input_sender, receiver) = mpsc::channel(options.channel_capacity);
    let input = SessionInput {
        receiver,
        state: state.clone(),
    };
    let (sender, output_receiver) = mpsc::channel(options.channel_capacity);
    let output = SessionOutput {
        output: Arc::new(Mutex::new(OutputState { sender, total: 0 })),
        state,
        limit: options.output_limit,
    };
    (input, input_sender, output, output_receiver)
}

impl SessionOutput {
    pub async fn send(&self, stream: SessionStream, bytes: &[u8]) -> Result<(), SessionIoError> {
        self.state.check()?;
        if self.state.output_closed.is_cancelled() {
            return Err(SessionIoError::Closed);
        }
        if bytes.len() > SESSION_CHUNK_LIMIT {
            let error = SessionIoError::ChunkTooLarge {
                limit: SESSION_CHUNK_LIMIT,
            };
            self.state.fail(error.to_string());
            return Err(error);
        }
        let cancel = self.state.context.cancellation();
        let deadline = Instant::from_std(self.state.context.deadline());
        let mut output = tokio::select! {
            biased;
            _ = sleep_until(deadline) => return self.timeout(),
            _ = cancel.cancelled() => return Err(SessionIoError::Cancelled),
            _ = self.state.output_closed.cancelled() => return Err(SessionIoError::Closed),
            output = self.output.lock() => output,
        };
        self.state.check()?;
        if self.state.output_closed.is_cancelled() {
            return Err(SessionIoError::Closed);
        }
        let total = match output
            .total
            .checked_add(bytes.len() as u64)
            .filter(|total| *total <= self.limit)
        {
            Some(total) => total,
            None => {
                let error = SessionIoError::OutputTooLarge { limit: self.limit };
                self.state.fail(error.to_string());
                return Err(error);
            }
        };
        let sender = output.sender.clone();
        let permit = tokio::select! {
            biased;
            _ = sleep_until(deadline) => return self.timeout(),
            _ = cancel.cancelled() => return Err(SessionIoError::Cancelled),
            _ = self.state.output_closed.cancelled() => return Err(SessionIoError::Closed),
            permit = sender.reserve() => permit.map_err(|_| SessionIoError::Closed)?,
        };
        self.state.check()?;
        if self.state.output_closed.is_cancelled() {
            return Err(SessionIoError::Closed);
        }
        // 共享准入锁覆盖 reserve、累计提交和复制，跨克隆的块不会重排。
        permit.send(Chunk {
            stream,
            bytes: bytes.to_vec(),
        });
        output.total = total;
        Ok(())
    }

    fn timeout(&self) -> Result<(), SessionIoError> {
        self.state.fail(crate::ContextError::Timeout.to_string());
        Err(SessionIoError::Timeout)
    }
}
