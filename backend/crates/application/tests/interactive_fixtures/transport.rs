use apk_domain::{
    Error, Result,
    interactive::{
        InteractiveSession, SESSION_CHUNK_LIMIT, SessionChunk, SessionCleanup, SessionExit,
        SessionInput, SessionOutcome, SessionResult, SessionStream,
    },
};
use async_trait::async_trait;
use serde_json::json;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

pub struct Input {
    cancel: CancellationToken,
    pub writes: Mutex<Vec<Vec<u8>>>,
    pub eof_calls: AtomicUsize,
    pub cancel_calls: AtomicUsize,
    eof: AtomicBool,
}

#[async_trait]
impl SessionInput for Input {
    async fn send(&self, bytes: &[u8]) -> SessionResult<()> {
        let mut writes = self.writes.lock().unwrap();
        if self.cancel.is_cancelled() {
            return Err(Arc::new(Error::Cancelled));
        }
        if self.eof.load(Ordering::SeqCst) {
            return Err(Arc::new(Error::Conflict("输入已经EOF".into())));
        }
        if bytes.len() > SESSION_CHUNK_LIMIT {
            return Err(Arc::new(Error::TooLarge));
        }
        writes.push(bytes.to_vec());
        Ok(())
    }

    async fn eof(&self) -> SessionResult<()> {
        let _writes = self.writes.lock().unwrap();
        if self.cancel.is_cancelled() {
            return Err(Arc::new(Error::Cancelled));
        }
        if self.eof.swap(true, Ordering::SeqCst) {
            return Err(Arc::new(Error::Conflict("输入已经EOF".into())));
        }
        self.eof_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn cancel(&self) {
        self.cancel_calls.fetch_add(1, Ordering::SeqCst);
        self.cancel.cancel();
    }
}

pub struct Control {
    pub input: Arc<Input>,
    cancel: CancellationToken,
    output: Mutex<Option<mpsc::Sender<SessionChunk>>>,
    ready: AtomicBool,
    ready_notify: Notify,
    hold_cleanup: bool,
    requested_exit: Mutex<Option<SessionExit>>,
    finish_notify: Notify,
    final_exit: Mutex<Option<Arc<SessionExit>>>,
    final_notify: Notify,
    pub cancelled: AtomicBool,
    pub published: AtomicBool,
    pub supervisor_finished: AtomicBool,
    pub pause_supervisor_tail: AtomicBool,
    tail_released: AtomicBool,
    tail_notify: Notify,
}

impl Control {
    pub fn new(
        cancel: CancellationToken,
        ready: bool,
        hold_cleanup: bool,
    ) -> (Arc<Self>, mpsc::Receiver<SessionChunk>) {
        let (sender, receiver) = mpsc::channel(16);
        let input = Arc::new(Input {
            cancel: CancellationToken::new(),
            writes: Mutex::new(Vec::new()),
            eof_calls: AtomicUsize::new(0),
            cancel_calls: AtomicUsize::new(0),
            eof: AtomicBool::new(false),
        });
        (
            Arc::new(Self {
                input,
                cancel,
                output: Mutex::new(Some(sender)),
                ready: AtomicBool::new(ready),
                ready_notify: Notify::new(),
                hold_cleanup,
                requested_exit: Mutex::new(None),
                finish_notify: Notify::new(),
                final_exit: Mutex::new(None),
                final_notify: Notify::new(),
                cancelled: AtomicBool::new(false),
                published: AtomicBool::new(false),
                supervisor_finished: AtomicBool::new(false),
                pause_supervisor_tail: AtomicBool::new(false),
                tail_released: AtomicBool::new(false),
                tail_notify: Notify::new(),
            }),
            receiver,
        )
    }

    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
        self.ready_notify.notify_waiters();
    }

    pub async fn emit(&self, sequence: u64, stream: SessionStream, bytes: Vec<u8>) -> Result<()> {
        let sender = self
            .output
            .lock()
            .unwrap()
            .clone()
            .ok_or(Error::Cancelled)?;
        sender
            .send(SessionChunk {
                sequence,
                stream,
                bytes,
            })
            .await
            .map_err(|_| Error::Cancelled)
    }

    pub fn finish(&self, exit: SessionExit) {
        let mut requested = self.requested_exit.lock().unwrap();
        assert!(requested.is_none(), "夹具不得重复发布结束请求");
        *requested = Some(exit);
        self.finish_notify.notify_one();
    }

    pub fn release_tail(&self) {
        self.tail_released.store(true, Ordering::SeqCst);
        self.tail_notify.notify_one();
    }

    pub async fn wait_cancelled(&self) {
        self.wait_flag(&self.cancelled, "没有收到会话取消").await;
    }

    pub async fn wait_published(&self) {
        self.wait_flag(&self.published, "监督没有缓存真实结论")
            .await;
    }

    async fn wait_flag(&self, flag: &AtomicBool, message: &str) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !flag.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect(message);
    }

    async fn requested(&self) -> SessionExit {
        loop {
            let notified = self.finish_notify.notified();
            if let Some(exit) = self.requested_exit.lock().unwrap().take() {
                return exit;
            }
            notified.await;
        }
    }

    pub async fn supervise(&self, unresolved: Arc<AtomicBool>) {
        let exit = loop {
            let notified = self.finish_notify.notified();
            if let Some(exit) = self.requested_exit.lock().unwrap().take() {
                break exit;
            }
            tokio::select! {
                _ = notified => {}
                _ = self.cancel.cancelled() => break self.cancelled_exit().await,
                _ = self.input.cancel.cancelled() => break self.cancelled_exit().await,
            }
        };
        if exit.cleanup != SessionCleanup::Complete || !exit.process_exited {
            unresolved.store(true, Ordering::SeqCst);
        }
        self.input.cancel();
        self.output.lock().unwrap().take();
        *self.final_exit.lock().unwrap() = Some(Arc::new(exit));
        self.published.store(true, Ordering::SeqCst);
        self.final_notify.notify_waiters();
        if self.pause_supervisor_tail.load(Ordering::SeqCst) {
            loop {
                let notified = self.tail_notify.notified();
                if self.tail_released.load(Ordering::SeqCst) {
                    break;
                }
                notified.await;
            }
        }
        self.supervisor_finished.store(true, Ordering::SeqCst);
    }

    async fn cancelled_exit(&self) -> SessionExit {
        self.cancelled.store(true, Ordering::SeqCst);
        if self.hold_cleanup {
            return self.requested().await;
        }
        SessionExit {
            outcome: None,
            cleanup: SessionCleanup::Complete,
            process_exited: true,
            sequence: None,
            failure: Some(Arc::new(Error::Cancelled)),
        }
    }
}

pub fn completed(sequence: u64) -> SessionExit {
    SessionExit {
        outcome: Some(SessionOutcome {
            result: Some(json!({"完成":true})),
            error: None,
            artifacts: Vec::new(),
        }),
        cleanup: SessionCleanup::Complete,
        process_exited: true,
        sequence: Some(sequence),
        failure: None,
    }
}

pub struct Handle {
    control: Arc<Control>,
    output: mpsc::Receiver<SessionChunk>,
}

impl Handle {
    pub fn new(control: Arc<Control>, output: mpsc::Receiver<SessionChunk>) -> Self {
        Self { control, output }
    }
}

#[async_trait]
impl InteractiveSession for Handle {
    fn input(&self) -> Arc<dyn SessionInput> {
        self.control.input.clone()
    }

    async fn ready(&self) -> SessionResult<()> {
        loop {
            let notified = self.control.ready_notify.notified();
            if self.control.ready.load(Ordering::SeqCst) {
                return Ok(());
            }
            tokio::select! {
                _ = notified => {}
                _ = self.control.cancel.cancelled() => return Err(Arc::new(Error::Cancelled)),
                _ = self.control.input.cancel.cancelled() => return Err(Arc::new(Error::Cancelled)),
            }
        }
    }

    async fn recv(&mut self) -> Option<SessionChunk> {
        self.output.recv().await
    }

    async fn wait(&mut self) -> Arc<SessionExit> {
        self.output.close();
        while self.output.recv().await.is_some() {}
        loop {
            let notified = self.control.final_notify.notified();
            if let Some(exit) = self.control.final_exit.lock().unwrap().clone() {
                return exit;
            }
            notified.await;
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.control.input.cancel();
    }
}
