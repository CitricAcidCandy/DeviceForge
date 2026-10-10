use apk_plugin_sdk::{cooperative::CleanupOutcome, session::SessionOpen};
use deviceforge_plugin_runtime::{
    Execution, InvocationContext,
    session::{SessionInput, SessionOptions, SessionOutput, serve_session_io},
};
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
    time::{Duration, Instant as WallInstant},
};
use tokio::{
    io::{
        AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, DuplexStream,
        ReadHalf, WriteHalf,
    },
    task::JoinHandle,
    time::Instant,
};

pub const ID: &str = "independent-session-5";
pub const BUDGET: Duration = Duration::from_secs(20);

pub async fn observe<F: Future>(future: F, stage: &str) -> F::Output {
    let fixed = Instant::now();
    let watchdog = WallInstant::now() + Duration::from_secs(12);
    tokio::pin!(future);
    loop {
        assert_eq!(Instant::now(), fixed, "观测不自动推进时钟：{stage}");
        assert!(WallInstant::now() < watchdog, "真实看门狗到期：{stage}");
        tokio::select! {
            biased;
            result = &mut future => return result,
            _ = tokio::task::yield_now() => {}
        }
    }
}

pub fn open() -> Value {
    json!({"protocol_version":5,"session_id":ID,"command":"open","operation":"independent.session","input":{"中文":"原始帧"}})
}
pub fn start(budget: Duration) -> Value {
    json!({"protocol_version":5,"session_id":ID,"command":"start","remaining_timeout_ns":u64::try_from(budget.as_nanos()).unwrap()})
}
pub fn input(bytes: &[u8]) -> Value {
    json!({"protocol_version":5,"session_id":ID,"command":"input","bytes":bytes})
}
pub fn eof() -> Value {
    json!({"protocol_version":5,"session_id":ID,"command":"eof"})
}
pub fn cancel() -> Value {
    json!({"protocol_version":5,"session_id":ID,"command":"cancel","reason":"cancelled"})
}

#[derive(Clone)]
pub struct WriteGate {
    allowed: Arc<AtomicBool>,
    waiting: Arc<AtomicBool>,
    waker: Arc<Mutex<Option<Waker>>>,
}
impl WriteGate {
    fn new() -> Self {
        Self {
            allowed: Arc::new(AtomicBool::new(true)),
            waiting: Arc::new(AtomicBool::new(false)),
            waker: Arc::new(Mutex::new(None)),
        }
    }
    pub fn stop(&self) {
        self.waiting.store(false, Ordering::SeqCst);
        self.allowed.store(false, Ordering::SeqCst);
    }
    pub fn is_waiting(&self) -> bool {
        self.waiting.load(Ordering::SeqCst)
    }
    pub fn release(&self) {
        self.allowed.store(true, Ordering::SeqCst);
        if let Some(waker) = self.waker.lock().unwrap().take() {
            waker.wake();
        }
    }
}
struct GatedWriter {
    writer: WriteHalf<DuplexStream>,
    gate: WriteGate,
}
impl AsyncWrite for GatedWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if !self.gate.allowed.load(Ordering::SeqCst) {
            self.gate.waiting.store(true, Ordering::SeqCst);
            *self.gate.waker.lock().unwrap() = Some(cx.waker().clone());
            return Poll::Pending;
        }
        Pin::new(&mut self.writer).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.writer).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.writer).poll_shutdown(cx)
    }
}

pub struct Session {
    pub reader: BufReader<ReadHalf<DuplexStream>>,
    pub writer: WriteHalf<DuplexStream>,
    pub running: JoinHandle<Result<(), String>>,
    pub write_gate: WriteGate,
}
impl Session {
    pub fn launch<F, Fut>(options: SessionOptions, capacity: usize, handler: F) -> Self
    where
        F: FnOnce(SessionOpen, InvocationContext, SessionInput, SessionOutput) -> Fut
            + Send
            + 'static,
        Fut: Future<Output = Execution> + Send + 'static,
    {
        let (host, plugin) = tokio::io::duplex(capacity);
        let (reader, writer) = tokio::io::split(plugin);
        let write_gate = WriteGate::new();
        let running = tokio::spawn(serve_session_io(
            reader,
            GatedWriter {
                writer,
                gate: write_gate.clone(),
            },
            options,
            handler,
        ));
        let (reader, writer) = tokio::io::split(host);
        Self {
            reader: BufReader::new(reader),
            writer,
            running,
            write_gate,
        }
    }
    pub async fn send_bytes(&mut self, bytes: &[u8]) {
        observe(self.writer.write_all(bytes), "写入原帧")
            .await
            .expect("写入内存双工");
    }
    pub async fn send(&mut self, value: &Value) {
        let mut bytes = serde_json::to_vec(value).unwrap();
        bytes.push(b'\n');
        self.send_bytes(&bytes).await;
    }
    pub async fn line(&mut self) -> Value {
        let mut bytes = Vec::new();
        observe(self.reader.read_until(b'\n', &mut bytes), "读取完整事件行")
            .await
            .unwrap();
        assert!(
            !bytes.is_empty() && bytes.len() <= 1024 * 1024,
            "事件行有界"
        );
        assert_eq!(bytes.last(), Some(&b'\n'));
        serde_json::from_slice(&bytes).expect("独立 JSON 帧")
    }
    pub async fn handshake(&mut self) -> Instant {
        let c0 = Instant::now();
        self.send(&open()).await;
        assert_eq!(
            self.line().await,
            json!({"protocol_version":5,"session_id":ID,"command":"ready"})
        );
        assert_eq!(Instant::now(), c0);
        c0
    }
    pub async fn begin(&mut self) -> Instant {
        let c0 = self.handshake().await;
        self.send(&start(BUDGET)).await;
        c0
    }
    pub async fn shutdown_input(&mut self) {
        observe(self.writer.shutdown(), "宿主关闭写半边")
            .await
            .unwrap();
    }
    pub async fn terminal(&mut self) -> Vec<Value> {
        let mut events = Vec::new();
        loop {
            let event = self.line().await;
            let finished = event["event"] == "finished";
            events.push(event);
            if finished {
                break;
            }
        }
        observe(&mut self.running, "等待运行库终态")
            .await
            .unwrap()
            .expect("写出终态成功");
        let mut rest = Vec::new();
        observe(self.reader.read_to_end(&mut rest), "终态后没有额外帧")
            .await
            .unwrap();
        assert!(rest.is_empty());
        events
    }
    pub async fn rejected(&mut self) {
        let error = observe(&mut self.running, "拒绝握手")
            .await
            .unwrap()
            .expect_err("握手必须拒绝");
        assert!(!error.trim().is_empty());
        let mut rest = Vec::new();
        observe(self.reader.read_to_end(&mut rest), "拒绝后不伪造终态")
            .await
            .unwrap();
        assert!(rest.is_empty());
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.running.abort();
    }
}

pub fn assert_order(events: &[Value], first: u64) {
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event["protocol_version"], 5);
        assert_eq!(event["session_id"], ID);
        assert_eq!(
            event["sequence"],
            first + index as u64,
            "双路输出与终态共享顺序"
        );
    }
}
pub fn assert_failure(event: &Value, cleanup: CleanupOutcome) {
    assert_eq!(event["event"], "finished");
    let outcome = &event["outcome"];
    assert!(outcome.get("result").is_none());
    assert!(
        outcome["error"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
    );
    assert!(
        outcome
            .get("outputs")
            .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
    );
    assert_eq!(
        outcome["cleanup"],
        if cleanup == CleanupOutcome::Complete {
            "complete"
        } else {
            "failed"
        }
    );
}
