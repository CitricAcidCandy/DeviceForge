use super::framing::{Codec, FRAME_LIMIT, QUEUE_LIMIT, Role};
use deviceforge_plugin_runtime::InvocationContext;
use serde_json::Value;
use std::sync::Arc;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::{
        TcpListener, TcpStream,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
    },
    sync::{Mutex, Semaphore},
    time::{Instant, sleep_until},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Identity {
    pub call_id: String,
    pub nonce: String,
}

impl Identity {
    pub fn create() -> Self {
        Self {
            call_id: uuid::Uuid::new_v4().to_string(),
            nonce: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
        }
    }
}

pub struct Incoming {
    reader: BufReader<OwnedReadHalf>,
    codec: Codec,
    partial: Vec<u8>,
}

struct WriteState {
    writer: OwnedWriteHalf,
    codec: Codec,
}

#[derive(Clone)]
pub struct Outgoing {
    state: Arc<Mutex<WriteState>>,
    capacity: Arc<Semaphore>,
}

pub fn split(
    stream: TcpStream,
    identity: &Identity,
    sender: Role,
    receiver: Role,
) -> Result<(Incoming, Outgoing), String> {
    let (reader, writer) = stream.into_split();
    Ok((
        Incoming {
            reader: BufReader::new(reader),
            codec: Codec::new(
                identity.call_id.clone(),
                identity.nonce.clone(),
                sender,
                receiver,
            )?,
            partial: Vec::new(),
        },
        Outgoing {
            state: Arc::new(Mutex::new(WriteState {
                writer,
                codec: Codec::new(
                    identity.call_id.clone(),
                    identity.nonce.clone(),
                    sender,
                    receiver,
                )?,
            })),
            capacity: Arc::new(Semaphore::new(QUEUE_LIMIT)),
        },
    ))
}

async fn until<T>(
    deadline: Instant,
    cancel: CancellationToken,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = sleep_until(deadline) => Err("SDK私有传输期限已到期".into()),
        _ = cancel.cancelled() => Err("SDK私有传输已停止".into()),
        result = work => result,
    }
}

impl Incoming {
    async fn read_frame(&mut self) -> Result<Option<Value>, String> {
        loop {
            let available = self
                .reader
                .fill_buf()
                .await
                .map_err(|_| "SDK私有连接读取失败")?;
            if available.is_empty() {
                return if self.partial.is_empty() {
                    Ok(None)
                } else {
                    Err("SDK私有连接EOF前帧不完整".into())
                };
            }
            let complete = available.iter().position(|byte| *byte == b'\n');
            let count = complete.map_or(available.len(), |position| position + 1);
            if count > FRAME_LIMIT.saturating_sub(self.partial.len()) {
                return Err("SDK私有连接帧超过64KiB".into());
            }
            self.partial.extend_from_slice(&available[..count]);
            self.reader.consume(count);
            if complete.is_some() {
                let result = self.codec.decode(&self.partial);
                self.partial.clear();
                return result.map(Some);
            }
        }
    }

    pub async fn read(&mut self, context: &InvocationContext) -> Result<Option<Value>, String> {
        context.check().map_err(|error| error.to_string())?;
        self.read_until(
            Instant::from_std(context.deadline()),
            context.cancellation(),
        )
        .await
    }

    pub async fn read_until(
        &mut self,
        deadline: Instant,
        cancel: CancellationToken,
    ) -> Result<Option<Value>, String> {
        until(deadline, cancel, self.read_frame()).await
    }
}

impl Outgoing {
    pub async fn send(&self, context: &InvocationContext, payload: Value) -> Result<(), String> {
        context.check().map_err(|error| error.to_string())?;
        self.send_until(
            Instant::from_std(context.deadline()),
            context.cancellation(),
            payload,
        )
        .await
    }

    pub async fn send_until(
        &self,
        deadline: Instant,
        cancel: CancellationToken,
        payload: Value,
    ) -> Result<(), String> {
        let permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| "SDK私有输出队列已满")?;
        until(deadline, cancel, async {
            let mut state = self.state.lock().await;
            let WriteState { writer, codec } = &mut *state;
            codec.write(writer, payload).await
        })
        .await?;
        drop(permit);
        Ok(())
    }
}

pub async fn listen() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| "SDK私有监听创建失败".into())
}

pub async fn accept(
    listener: &TcpListener,
    context: &InvocationContext,
    identity: &Identity,
    receiver: Role,
) -> Result<(Incoming, Outgoing), String> {
    context.check().map_err(|error| error.to_string())?;
    let deadline = Instant::from_std(context.deadline())
        .min(Instant::now() + std::time::Duration::from_millis(1000));
    let (stream, address) = until(deadline, context.cancellation(), async {
        listener
            .accept()
            .await
            .map_err(|_| "SDK私有连接接收失败".into())
    })
    .await?;
    if !address.ip().is_loopback() {
        return Err("SDK私有连接必须来自本机".into());
    }
    split(stream, identity, Role::Coordinator, receiver)
}
