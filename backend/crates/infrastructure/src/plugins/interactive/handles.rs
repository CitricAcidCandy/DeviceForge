//! 会话输入和输出句柄；客户端等待取消不移交后台监督所有权。
use apk_domain::{Error, interactive::*};
use async_trait::async_trait;
use std::{sync::Arc, time::Instant};
use tokio::sync::{Mutex, mpsc, watch};
use tokio_util::sync::CancellationToken;

pub(super) const CAPACITY: usize = 8;
pub(super) const INPUT_LIMIT: u64 = 1024 * 1024;
pub(super) const OUTPUT_LIMIT: u64 = 16 * 1024 * 1024;
pub(super) const MESSAGE_LIMIT: u64 = 65536;
type Ready = Option<SessionResult<()>>;

pub(super) enum Command {
    Input(Vec<u8>),
    Eof,
}

struct Admission {
    sender: mpsc::Sender<Command>,
    bytes: u64,
    messages: u64,
    eof: bool,
}

struct Input {
    state: Mutex<Admission>,
    cancel: CancellationToken,
    revoked: CancellationToken,
    deadline: tokio::time::Instant,
    ready: watch::Receiver<Ready>,
    ready_failure: std::sync::Mutex<Option<Arc<Error>>>,
}

pub(super) struct Handle {
    input: Arc<Input>,
    output: mpsc::Receiver<SessionChunk>,
    ready: watch::Receiver<Ready>,
    exit: watch::Receiver<Option<Arc<SessionExit>>>,
    terminal: Option<Arc<SessionExit>>,
}

pub(super) struct Channels {
    pub commands: mpsc::Receiver<Command>,
    pub output: mpsc::Sender<SessionChunk>,
    pub ready: watch::Sender<Ready>,
    pub exit: watch::Sender<Option<Arc<SessionExit>>>,
    pub revoked: CancellationToken,
}

pub(super) fn channel(deadline: Instant, cancel: CancellationToken) -> (Handle, Channels) {
    let (sender, commands) = mpsc::channel(CAPACITY);
    let (output, receiver) = mpsc::channel(CAPACITY);
    let (ready, ready_receiver) = watch::channel(None);
    let (exit, exit_receiver) = watch::channel(None);
    let revoked = CancellationToken::new();
    let input = Arc::new(Input {
        state: Mutex::new(Admission {
            sender,
            bytes: 0,
            messages: 0,
            eof: false,
        }),
        cancel,
        revoked: revoked.clone(),
        deadline: tokio::time::Instant::from_std(deadline),
        ready: ready_receiver.clone(),
        ready_failure: std::sync::Mutex::new(None),
    });
    (
        Handle {
            input,
            output: receiver,
            ready: ready_receiver,
            exit: exit_receiver,
            terminal: None,
        },
        Channels {
            commands,
            output,
            ready,
            exit,
            revoked,
        },
    )
}

impl Input {
    fn ready_failed(&self, error: Arc<Error>) -> Arc<Error> {
        self.ready_failure
            .lock()
            .expect("会话准备错误锁未污染")
            .get_or_insert(error)
            .clone()
    }

    fn ready_or_failed(
        &self,
        receiver: &watch::Receiver<Ready>,
        error: Arc<Error>,
    ) -> SessionResult<()> {
        // 已挂起的选择在重新唤醒时可能同时看到终态和撤销，优先真实 ready 结论。
        if let Some(result) = receiver.borrow().clone() {
            return result;
        }
        Err(self.ready_failed(error))
    }

    async fn wait_ready(&self, mut receiver: watch::Receiver<Ready>) -> SessionResult<()> {
        loop {
            if let Some(error) = self
                .ready_failure
                .lock()
                .expect("会话准备错误锁未污染")
                .clone()
            {
                return Err(error);
            }
            if let Some(result) = receiver.borrow().clone() {
                return result;
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return self.ready_or_failed(&receiver, self.closed()),
                _ = self.revoked.cancelled() => return self.ready_or_failed(&receiver, self.closed()),
                _ = tokio::time::sleep_until(self.deadline) => return self.ready_or_failed(&receiver, self.closed()),
                changed = receiver.changed() => if changed.is_err() {
                    return self.ready_or_failed(&receiver, Arc::new(Error::CleanupFailed));
                },
            }
        }
    }

    fn unavailable(&self) -> bool {
        self.cancel.is_cancelled()
            || self.revoked.is_cancelled()
            || tokio::time::Instant::now() >= self.deadline
    }

    fn closed(&self) -> Arc<Error> {
        Arc::new(if tokio::time::Instant::now() >= self.deadline {
            Error::Timeout
        } else if self.cancel.is_cancelled() {
            Error::Cancelled
        } else {
            Error::Conflict("会话输入已关闭".into())
        })
    }

    async fn admit(&self, bytes: Option<&[u8]>) -> SessionResult<()> {
        if bytes.is_some_and(|bytes| bytes.len() > 8192) {
            return Err(Arc::new(Error::TooLarge));
        }
        self.wait_ready(self.ready.clone()).await?;
        let mut state = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(self.closed()),
            _ = self.revoked.cancelled() => return Err(self.closed()),
            _ = tokio::time::sleep_until(self.deadline) => return Err(self.closed()),
            state = self.state.lock() => state,
        };
        if self.unavailable() {
            return Err(self.closed());
        }
        if state.eof {
            return Err(Arc::new(Error::Conflict("会话输入已交付 EOF".into())));
        }
        let total = state
            .bytes
            .checked_add(bytes.map_or(0, |bytes| bytes.len() as u64))
            .filter(|value| *value <= INPUT_LIMIT)
            .ok_or_else(|| Arc::new(Error::TooLarge))?;
        if state.messages >= MESSAGE_LIMIT {
            return Err(Arc::new(Error::TooLarge));
        }
        let sender = state.sender.clone();
        let permit = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(self.closed()),
            _ = self.revoked.cancelled() => return Err(self.closed()),
            _ = tokio::time::sleep_until(self.deadline) => return Err(self.closed()),
            permit = sender.reserve() => permit.map_err(|_| self.closed())?,
        };
        if self.unavailable() {
            return Err(self.closed());
        }
        let message = if let Some(bytes) = bytes {
            Command::Input(bytes.to_vec())
        } else {
            state.eof = true;
            Command::Eof
        };
        state.bytes = total;
        state.messages += 1;
        permit.send(message);
        Ok(())
    }
}

#[async_trait]
impl SessionInput for Input {
    async fn send(&self, bytes: &[u8]) -> SessionResult<()> {
        self.admit(Some(bytes)).await
    }
    async fn eof(&self) -> SessionResult<()> {
        self.admit(None).await
    }
    fn cancel(&self) {
        self.cancel.cancel();
    }
}

#[async_trait]
impl InteractiveSession for Handle {
    fn input(&self) -> Arc<dyn SessionInput> {
        self.input.clone()
    }
    async fn ready(&self) -> SessionResult<()> {
        self.input.wait_ready(self.ready.clone()).await
    }
    async fn recv(&mut self) -> Option<SessionChunk> {
        self.output.recv().await
    }
    async fn wait(&mut self) -> Arc<SessionExit> {
        let mut output_closed = false;
        loop {
            let exit = self.terminal.clone().or_else(|| self.exit.borrow().clone());
            if let Some(exit) = exit {
                self.output.close();
                while self.output.try_recv().is_ok() {}
                self.terminal = Some(exit.clone());
                return exit;
            }
            tokio::select! {
                biased;
                changed = self.exit.changed() => if changed.is_err() {
                    self.terminal = Some(Arc::new(SessionExit { sequence: None, outcome: None,
                        cleanup: SessionCleanup::Unconfirmed, process_exited: false,
                        failure: Some(Arc::new(Error::CleanupFailed)) }));
                },
                chunk = self.output.recv(), if !output_closed => output_closed = chunk.is_none(),
            }
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.input.cancel();
    }
}

impl Drop for Channels {
    fn drop(&mut self) {
        // 尚未轮询的监督被丢弃时也发布同一缓存结论，不虚构进程确认。
        let failure = Arc::new(Error::CleanupFailed);
        if self.ready.borrow().is_none() {
            self.ready.send_replace(Some(Err(failure.clone())));
        }
        if self.exit.borrow().is_none() {
            self.exit.send_replace(Some(Arc::new(SessionExit {
                sequence: None,
                outcome: None,
                cleanup: SessionCleanup::Unconfirmed,
                process_exited: false,
                failure: Some(failure),
            })));
        }
        self.revoked.cancel();
    }
}
