use super::PtySize;
use crate::{InputError, StreamOptions};
use std::sync::Arc;
use tokio::{
    sync::{Mutex, mpsc},
    time,
};
use tokio_util::sync::CancellationToken;

pub(super) enum Message {
    Bytes(Vec<u8>),
    Resize(PtySize),
    Eof,
}

struct State {
    sender: mpsc::Sender<Message>,
    sent: u64,
    closed: bool,
}

#[derive(Clone)]
pub struct PtyInput {
    state: Arc<Mutex<State>>,
    cancel: CancellationToken,
    deadline: time::Instant,
    chunk_size: usize,
    input_limit: u64,
}

pub(super) fn channel(
    options: StreamOptions,
    cancel: CancellationToken,
) -> (PtyInput, mpsc::Receiver<Message>) {
    let (sender, receiver) = mpsc::channel(options.channel_capacity);
    (
        PtyInput {
            state: Arc::new(Mutex::new(State {
                sender,
                sent: 0,
                closed: false,
            })),
            cancel,
            deadline: options.execution.deadline,
            chunk_size: options.chunk_size,
            input_limit: options.input_limit,
        },
        receiver,
    )
}

impl PtyInput {
    pub async fn send(&self, bytes: &[u8]) -> Result<(), InputError> {
        if bytes.len() > self.chunk_size {
            return Err(InputError::ChunkTooLarge {
                limit: self.chunk_size,
            });
        }
        self.admit(Message::Bytes(bytes.to_vec())).await
    }

    pub async fn resize(&self, size: PtySize) -> Result<(), InputError> {
        if PtySize::new(size.cols, size.rows).is_err() {
            return Err(InputError::Closed);
        }
        self.admit(Message::Resize(size)).await
    }

    pub async fn close(&self) -> Result<(), InputError> {
        self.admit(Message::Eof).await
    }

    async fn admit(&self, message: Message) -> Result<(), InputError> {
        let mut state = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(InputError::Closed),
            _ = time::sleep_until(self.deadline) => return Err(InputError::Closed),
            state = self.state.lock() => state,
        };
        if state.closed {
            return Err(InputError::Closed);
        }
        let size = match &message {
            Message::Bytes(bytes) => bytes.len(),
            _ => 0,
        };
        let total = state
            .sent
            .checked_add(size as u64)
            .filter(|value| *value <= self.input_limit)
            .ok_or(InputError::InputTooLarge {
                limit: self.input_limit,
            })?;
        let sender = state.sender.clone();
        let permit = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(InputError::Closed),
            _ = time::sleep_until(self.deadline) => return Err(InputError::Closed),
            permit = sender.reserve() => permit.map_err(|_| InputError::Closed)?,
        };
        if self.cancel.is_cancelled() || time::Instant::now() >= self.deadline {
            return Err(InputError::Closed);
        }
        state.closed = matches!(message, Message::Eof);
        state.sent = total;
        permit.send(message);
        Ok(())
    }
}
