//! 手工协议 4 原帧验证公开运行库，不复用 SDK 帧序列化或私有计时接缝。
//! 暂停时间只证明本进程 C0/收口规则；墙钟看门狗不构成性能或真实进程证据。

use apk_plugin_sdk::{ArtifactOutput, Request, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{
    ContextError, Execution, InvocationContext, Output, serve_io_with_context,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant as WallInstant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf},
    sync::oneshot,
    task::JoinHandle,
    time::{Instant, advance},
};

const REQUEST_ID: &str = "context-independent-1";
const BUDGET: Duration = Duration::from_secs(20);
const WATCHDOG: Duration = Duration::from_secs(12);
const TIMEOUT_MESSAGE: &str = "插件执行期限已到期";

// 始终保留可运行的 yield，防止暂停时钟在等待 duplex/门闩时自行跳到下一定时器。
async fn observe<F: Future>(future: F, stage: &str) -> F::Output {
    let fixed_time = Instant::now();
    let watchdog = WallInstant::now() + WATCHDOG;
    tokio::pin!(future);
    loop {
        assert_eq!(
            Instant::now(),
            fixed_time,
            "观测等待不能自动推进时钟：{stage}"
        );
        assert!(WallInstant::now() < watchdog, "真实看门狗到期：{stage}");
        tokio::select! {
            biased;
            result = &mut future => {
                assert_eq!(Instant::now(), fixed_time, "观测结束时钟仍固定：{stage}");
                return result;
            }
            _ = tokio::task::yield_now() => {}
        }
    }
}

fn request() -> Value {
    json!({
        "protocol_version":4,
        "request_id":REQUEST_ID,
        "operation":"independent.context",
        "input":{"value":"中文独立原帧"}
    })
}

fn start(remaining: Duration) -> Value {
    json!({
        "protocol_version":4,
        "request_id":REQUEST_ID,
        "command":"start",
        "remaining_timeout_ns":u64::try_from(remaining.as_nanos()).expect("测试预算可表示")
    })
}

fn cancel() -> Value {
    json!({
        "protocol_version":4,
        "request_id":REQUEST_ID,
        "command":"cancel",
        "reason":"cancelled"
    })
}

struct Session {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    running: JoinHandle<Result<(), String>>,
}

impl Session {
    fn launch<F, Fut>(handler: F) -> Self
    where
        F: FnOnce(Request, InvocationContext) -> Fut + Send + 'static,
        Fut: Future<Output = Execution> + Send + 'static,
    {
        let (host, plugin) = tokio::io::duplex(64 * 1024);
        let (reader, writer) = tokio::io::split(plugin);
        let running = tokio::spawn(serve_io_with_context(reader, writer, handler));
        let (reader, writer) = tokio::io::split(host);
        Self {
            reader: BufReader::new(reader),
            writer,
            running,
        }
    }

    async fn send_bytes(&mut self, bytes: &[u8]) {
        observe(self.writer.write_all(bytes), "写入手工帧")
            .await
            .expect("duplex 写入帧");
    }

    async fn send(&mut self, value: &Value) {
        let mut bytes = serde_json::to_vec(value).expect("手工 JSON 可编码");
        bytes.push(b'\n');
        self.send_bytes(&bytes).await;
    }

    async fn handshake(&mut self) -> Instant {
        let c0 = Instant::now();
        self.send(&request()).await;
        let mut line = Vec::new();
        observe(
            tokio::io::AsyncBufReadExt::read_until(&mut self.reader, b'\n', &mut line),
            "读取 Ready 原帧",
        )
        .await
        .expect("Ready 读取成功");
        assert!(!line.is_empty() && line.len() <= 4096, "Ready 帧有界且非空");
        assert_eq!(line.last(), Some(&b'\n'), "Ready 必须换行结束");
        let ready: Value = serde_json::from_slice(&line).expect("Ready 为完整 JSON");
        assert_eq!(
            ready,
            json!({"protocol_version":4,"request_id":REQUEST_ID,"command":"ready"})
        );
        assert_eq!(Instant::now(), c0, "初始请求到 Ready 未推进模拟时间");
        c0
    }

    async fn eof(&mut self) {
        observe(self.writer.shutdown(), "关闭宿主输入")
            .await
            .expect("只关闭写半边，保留响应读取");
    }

    async fn reply(&mut self) -> Value {
        let mut bytes = Vec::new();
        observe(self.reader.read_to_end(&mut bytes), "读取完整终态响应")
            .await
            .expect("读取响应成功");
        observe(&mut self.running, "等待运行库返回")
            .await
            .expect("运行库任务正常返回")
            .expect("运行库写完合法终态响应");
        assert!(
            !bytes.is_empty() && bytes.len() < 1024 * 1024,
            "终态响应有界"
        );
        assert_eq!(bytes.last(), Some(&b'\n'), "响应换行结束");
        assert_eq!(
            bytes.iter().filter(|byte| **byte == b'\n').count(),
            1,
            "Ready 后只返回一次终态帧"
        );
        let reply: Value = serde_json::from_slice(&bytes).expect("只包含一份 JSON 响应");
        assert_eq!(reply["response"]["protocol_version"], 4);
        assert_eq!(reply["response"]["request_id"], REQUEST_ID);
        reply
    }

    async fn rejected(&mut self) {
        let error = observe(&mut self.running, "坏握手应直接拒绝")
            .await
            .expect("拒绝握手任务正常返回")
            .expect_err("坏初始请求或 Start 不可接受");
        assert!(!error.trim().is_empty(), "握手拒绝必须有诊断");
        let mut bytes = Vec::new();
        observe(self.reader.read_to_end(&mut bytes), "拒绝后无业务响应")
            .await
            .expect("拒绝后关闭输出");
        assert!(bytes.is_empty(), "坏握手不得伪造业务终态响应");
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // 断言失败时只中止本测试拥有的内存任务，不启动或终止任何外部进程。
        self.running.abort();
    }
}

fn assert_deadline(context: &InvocationContext, c0: Instant, budget: Duration) {
    assert_eq!(
        Instant::from_std(context.deadline()),
        c0 + budget,
        "公开 D 必须等于 C0+R"
    );
    assert_eq!(
        context.clone().deadline(),
        context.deadline(),
        "克隆不重建期限"
    );
}

fn assert_failure(reply: &Value, cleanup: CleanupOutcome, exact_error: Option<&str>) {
    assert_eq!(
        reply["cleanup"],
        if cleanup == CleanupOutcome::Complete {
            "complete"
        } else {
            "failed"
        }
    );
    assert!(
        reply["response"].get("result").is_none(),
        "晚成功/业务结果必须移除"
    );
    assert!(
        reply["response"]
            .get("outputs")
            .is_none_or(|outputs| outputs.as_array().is_some_and(Vec::is_empty)),
        "失败不能返回产物声明"
    );
    let error = reply["response"]["error"].as_str().expect("明确响应错误");
    assert!(!error.trim().is_empty());
    if let Some(expected) = exact_error {
        assert_eq!(error, expected, "到期或原业务错误不可被泛化");
    }
}

fn counted_session(calls: Arc<AtomicUsize>) -> Session {
    Session::launch(move |_, _| {
        calls.fetch_add(1, Ordering::SeqCst);
        async { Execution::complete(Ok(json!({"unexpected_handler":true}).into())) }
    })
}

async fn rejected_start(frame: Value) {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut session = counted_session(calls.clone());
    session.handshake().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0, "Ready 前后零 handler");
    session.send(&frame).await;
    // 保持输入打开，不能让 EOF 的另一个错误掩盖坏 Start 被错误接受。
    session.rejected().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0, "坏 Start 零业务调用");
}

struct Controlled {
    session: Session,
    context: InvocationContext,
    c0: Instant,
    signalled: oneshot::Receiver<()>,
    release: Option<oneshot::Sender<()>>,
    returned: Arc<AtomicBool>,
    calls: Arc<AtomicUsize>,
}

impl Controlled {
    async fn begin(cleanup: CleanupOutcome) -> Self {
        Self::begin_after(cleanup, Duration::ZERO).await
    }

    async fn begin_after(cleanup: CleanupOutcome, delay: Duration) -> Self {
        let calls = Arc::new(AtomicUsize::new(0));
        let invocation_count = calls.clone();
        let returned = Arc::new(AtomicBool::new(false));
        let return_marker = returned.clone();
        let (entered, context) = oneshot::channel();
        let (signal, signalled) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let mut session = Session::launch(move |request, context| {
            invocation_count.fetch_add(1, Ordering::SeqCst);
            async move {
                assert_eq!(request.request_id, REQUEST_ID);
                assert!(entered.send(context.clone()).is_ok(), "报告公开上下文");
                let cancel = context.cancellation();
                cancel.cancelled().await;
                signal.send(()).expect("报告 handler 实际收到取消");
                gate.await.expect("等待自有清理门闩，不允许丢弃 handler");
                return_marker.store(true, Ordering::SeqCst);
                Execution {
                    outcome: Ok(Output {
                        value: json!({"late_success":true}),
                        artifacts: vec![ArtifactOutput {
                            filename: "late.json".into(),
                        }],
                    }),
                    cleanup,
                }
            }
        });
        let c0 = session.handshake().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0, "Start 前不调用 handler");
        if !delay.is_zero() {
            advance(delay).await;
            assert_eq!(Instant::now(), c0 + delay, "只推进指定握手延迟");
            assert_eq!(calls.load(Ordering::SeqCst), 0, "延迟 Start 期间零 handler");
        }
        session.send(&start(BUDGET)).await;
        let context = observe(context, "等待 handler 公开上下文")
            .await
            .expect("handler 已进入");
        assert_deadline(&context, c0, BUDGET);
        assert!(context.check().is_ok());
        Self {
            session,
            context,
            c0,
            signalled,
            release: Some(release),
            returned,
            calls,
        }
    }

    async fn cancelled_but_not_returned(&mut self) {
        observe(&mut self.signalled, "等待 handler 收到停止信号")
            .await
            .expect("handler 明确观测取消");
        assert!(!self.returned.load(Ordering::SeqCst), "清理门闩未放行");
        assert!(
            !self.session.running.is_finished(),
            "必须等待 handler 真实收口"
        );
        assert_eq!(self.calls.load(Ordering::SeqCst), 1);
        assert_deadline(&self.context, self.c0, BUDGET);
    }

    async fn finish(&mut self) -> Value {
        self.release
            .take()
            .expect("清理门闩只放行一次")
            .send(())
            .expect("handler 仍受跟踪");
        let reply = self.session.reply().await;
        assert!(
            self.returned.load(Ordering::SeqCst),
            "处理器真实返回后才报告 cleanup"
        );
        assert_eq!(
            self.calls.load(Ordering::SeqCst),
            1,
            "同次请求仅一个 handler"
        );
        reply
    }

    async fn expire(&mut self) {
        let remaining = (self.c0 + BUDGET).duration_since(Instant::now());
        advance(remaining).await;
        assert_deadline(&self.context, self.c0, BUDGET);
        assert!(
            matches!(self.context.check(), Err(ContextError::Timeout)),
            "数学 D 已到期"
        );
        // 不重置业务 D；只让 sleep_until 的毫秒刻度完成观测唤醒。
        advance(Duration::from_millis(1)).await;
        self.cancelled_but_not_returned().await;
    }
}

#[tokio::test(start_paused = true)]
async fn normal_handwritten_frames_preserve_request_deadline_and_output() {
    let c0 = Instant::now();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let mut session = Session::launch(move |request, context| {
        count.fetch_add(1, Ordering::SeqCst);
        async move {
            assert_eq!(request.protocol_version, 4);
            assert_eq!(request.request_id, REQUEST_ID);
            assert_eq!(request.operation, "independent.context");
            assert_eq!(request.input, json!({"value":"中文独立原帧"}));
            assert!(request.artifacts.is_none());
            assert_deadline(&context, c0, BUDGET);
            assert!(context.check().is_ok());
            assert!(!context.cancellation().is_cancelled());
            Execution::complete(Ok(Output {
                value: json!({"transported":"中文原结果"}),
                // 这里只证明公开产物描述的原帧，不冒称真实文件发布。
                artifacts: vec![ArtifactOutput {
                    filename: "result.json".into(),
                }],
            }))
        }
    });
    assert_eq!(session.handshake().await, c0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    session.send(&start(BUDGET)).await;
    let reply = session.reply().await;
    assert_eq!(reply["cleanup"], "complete");
    assert_eq!(
        reply["response"]["result"],
        json!({"transported":"中文原结果"})
    );
    assert_eq!(
        reply["response"]["outputs"],
        json!([{"filename":"result.json"}])
    );
    assert!(reply["response"].get("error").is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn maximum_remaining_integer_is_accepted_without_default_or_clamping() {
    let c0 = Instant::now();
    let maximum = Duration::from_secs(3600);
    let mut session = Session::launch(move |_, context| async move {
        assert_deadline(&context, c0, maximum);
        assert!(context.check().is_ok());
        Execution::complete(Ok(json!({"maximum":true}).into()))
    });
    assert_eq!(session.handshake().await, c0);
    session.send(&start(maximum)).await;
    let reply = session.reply().await;
    assert_eq!(reply["response"]["result"], json!({"maximum":true}));
    assert_eq!(reply["cleanup"], "complete");
}

#[tokio::test(start_paused = true)]
async fn zero_start_returns_exact_timeout_and_never_calls_handler() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut session = counted_session(calls.clone());
    session.handshake().await;
    session.send(&start(Duration::ZERO)).await;
    let reply = session.reply().await;
    assert_failure(&reply, CleanupOutcome::Complete, Some(TIMEOUT_MESSAGE));
    assert_eq!(calls.load(Ordering::SeqCst), 0, "0 不得恢复默认预算");
}

#[tokio::test(start_paused = true)]
async fn start_arriving_after_c0_budget_expires_never_calls_handler() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut session = counted_session(calls.clone());
    let c0 = session.handshake().await;
    advance(Duration::from_secs(6)).await;
    assert_eq!(Instant::now(), c0 + Duration::from_secs(6));
    assert_eq!(calls.load(Ordering::SeqCst), 0, "等待 Start 不能先调用业务");
    session.send(&start(Duration::from_secs(5))).await;
    let reply = session.reply().await;
    assert_failure(&reply, CleanupOutcome::Complete, Some(TIMEOUT_MESSAGE));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "期限必须从 C0 而非 Start 接收点计算"
    );
}

#[tokio::test(start_paused = true)]
async fn delayed_valid_start_consumes_budget_before_handler_and_keeps_original_d() {
    let mut controlled =
        Controlled::begin_after(CleanupOutcome::Complete, Duration::from_secs(5)).await;
    assert_eq!(Instant::now(), controlled.c0 + Duration::from_secs(5));
    assert_eq!(
        Instant::from_std(controlled.context.deadline()).duration_since(Instant::now()),
        Duration::from_secs(15)
    );
    controlled.expire().await;
    let reply = controlled.finish().await;
    assert_failure(&reply, CleanupOutcome::Complete, Some(TIMEOUT_MESSAGE));
}

#[tokio::test(start_paused = true)]
async fn initial_request_wrong_versions_are_rejected_without_ready_or_handler() {
    for version in [1, 2, 3, 5] {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut session = counted_session(calls.clone());
        let mut invalid = request();
        invalid["protocol_version"] = json!(version);
        session.send(&invalid).await;
        session.rejected().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn initial_request_invalid_ids_and_unknown_fields_never_call_handler() {
    let mut empty_id = request();
    empty_id["request_id"] = json!("");
    let mut long_id = request();
    long_id["request_id"] = json!("x".repeat(129));
    let mut unknown = request();
    unknown["private_deadline"] = json!(1);
    for invalid in [empty_id, long_id, unknown] {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut session = counted_session(calls.clone());
        session.send(&invalid).await;
        session.rejected().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn start_with_bad_id_is_rejected_without_handler() {
    let mut invalid = start(BUDGET);
    invalid["request_id"] = json!("other-context-id");
    rejected_start(invalid).await;
}

#[tokio::test(start_paused = true)]
async fn start_with_wrong_version_is_rejected_without_handler() {
    for version in [3, 5] {
        let mut invalid = start(BUDGET);
        invalid["protocol_version"] = json!(version);
        rejected_start(invalid).await;
    }
}

#[tokio::test(start_paused = true)]
async fn start_unknown_fields_wrong_command_and_invalid_integer_are_rejected() {
    let mut extra = start(BUDGET);
    extra["renew"] = json!(true);
    let mut wrong_command = start(BUDGET);
    wrong_command["command"] = json!("ready");
    let mut missing = start(BUDGET);
    missing
        .as_object_mut()
        .expect("手工 Start 对象")
        .remove("remaining_timeout_ns");
    for invalid in [extra, wrong_command, missing] {
        rejected_start(invalid).await;
    }
    for value in [
        json!(null),
        json!(-1),
        json!(1.5),
        json!("1000"),
        json!(3_600_000_000_001u64),
    ] {
        let mut invalid = start(BUDGET);
        invalid["remaining_timeout_ns"] = value;
        rejected_start(invalid).await;
    }
}

#[tokio::test(start_paused = true)]
async fn incomplete_and_oversized_start_frames_do_not_invoke_handler() {
    for oversized in [false, true] {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut session = counted_session(calls.clone());
        session.handshake().await;
        if oversized {
            let mut bytes = vec![b'x'; 4097];
            bytes.push(b'\n');
            session.send_bytes(&bytes).await;
        } else {
            session.send_bytes(b"{\"protocol_version\":4").await;
            session.eof().await;
        }
        session.rejected().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn eof_before_start_never_calls_handler() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut session = counted_session(calls.clone());
    session.handshake().await;
    session.eof().await;
    session.rejected().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn repeated_start_is_bad_control_and_cannot_renew_the_first_deadline() {
    let mut controlled = Controlled::begin(CleanupOutcome::Complete).await;
    advance(Duration::from_secs(3)).await;
    controlled
        .session
        .send(&start(Duration::from_secs(3600)))
        .await;
    controlled.cancelled_but_not_returned().await;
    assert!(
        matches!(controlled.context.check(), Err(ContextError::Cancelled)),
        "原 D 前的坏控制通知取消"
    );
    assert_deadline(&controlled.context, controlled.c0, BUDGET);
    let reply = controlled.finish().await;
    assert_failure(&reply, CleanupOutcome::Complete, None);
    assert_ne!(
        reply["response"]["error"].as_str(),
        Some(TIMEOUT_MESSAGE),
        "重复 Start 不能伪装成原期限到期"
    );
}

#[tokio::test(start_paused = true)]
async fn local_deadline_waits_for_real_handler_cleanup_and_rejects_late_success() {
    let mut controlled = Controlled::begin(CleanupOutcome::Complete).await;
    controlled.expire().await;
    let reply = controlled.finish().await;
    assert_failure(&reply, CleanupOutcome::Complete, Some(TIMEOUT_MESSAGE));
}

#[tokio::test(start_paused = true)]
async fn host_cancel_waits_for_real_handler_cleanup_and_rejects_late_success() {
    let mut controlled = Controlled::begin(CleanupOutcome::Complete).await;
    controlled.session.send(&cancel()).await;
    controlled.cancelled_but_not_returned().await;
    assert!(matches!(
        controlled.context.check(),
        Err(ContextError::Cancelled)
    ));
    let reply = controlled.finish().await;
    assert_failure(&reply, CleanupOutcome::Complete, None);
    assert_ne!(reply["response"]["error"].as_str(), Some(TIMEOUT_MESSAGE));
}

#[tokio::test(start_paused = true)]
async fn host_eof_waits_for_real_handler_cleanup_and_rejects_late_success() {
    let mut controlled = Controlled::begin(CleanupOutcome::Complete).await;
    controlled.session.eof().await;
    controlled.cancelled_but_not_returned().await;
    assert!(matches!(
        controlled.context.check(),
        Err(ContextError::Cancelled)
    ));
    let reply = controlled.finish().await;
    assert_failure(&reply, CleanupOutcome::Complete, None);
    assert_ne!(reply["response"]["error"].as_str(), Some(TIMEOUT_MESSAGE));
}

#[tokio::test(start_paused = true)]
async fn bad_running_control_frames_notify_cleanup_and_reject_late_success() {
    let mut wrong_id = cancel();
    wrong_id["request_id"] = json!("other-running-id");
    let mut old_version = cancel();
    old_version["protocol_version"] = json!(3);
    let mut unknown = cancel();
    unknown["private_reason"] = json!("ignored");
    let mut bad_reason = cancel();
    bad_reason["reason"] = json!("unknown_reason");
    let mut missing_reason = cancel();
    missing_reason
        .as_object_mut()
        .expect("手工控制对象")
        .remove("reason");
    for frame in [wrong_id, old_version, unknown, bad_reason, missing_reason] {
        let mut controlled = Controlled::begin(CleanupOutcome::Complete).await;
        controlled.session.send(&frame).await;
        controlled.cancelled_but_not_returned().await;
        assert!(matches!(
            controlled.context.check(),
            Err(ContextError::Cancelled)
        ));
        let reply = controlled.finish().await;
        assert_failure(&reply, CleanupOutcome::Complete, None);
    }
}

#[tokio::test(start_paused = true)]
async fn local_deadline_preserves_failed_cleanup_even_if_handler_returns_success() {
    let mut controlled = Controlled::begin(CleanupOutcome::Failed).await;
    controlled.expire().await;
    let reply = controlled.finish().await;
    assert_failure(&reply, CleanupOutcome::Failed, Some(TIMEOUT_MESSAGE));
}

#[tokio::test(start_paused = true)]
async fn host_cancel_preserves_failed_cleanup_even_if_handler_returns_success() {
    let mut controlled = Controlled::begin(CleanupOutcome::Failed).await;
    controlled.session.send(&cancel()).await;
    controlled.cancelled_but_not_returned().await;
    assert!(matches!(
        controlled.context.check(),
        Err(ContextError::Cancelled)
    ));
    let reply = controlled.finish().await;
    assert_failure(&reply, CleanupOutcome::Failed, None);
}

#[tokio::test(start_paused = true)]
async fn host_eof_preserves_failed_cleanup_even_if_handler_returns_success() {
    let mut controlled = Controlled::begin(CleanupOutcome::Failed).await;
    controlled.session.eof().await;
    controlled.cancelled_but_not_returned().await;
    assert!(matches!(
        controlled.context.check(),
        Err(ContextError::Cancelled)
    ));
    let reply = controlled.finish().await;
    assert_failure(&reply, CleanupOutcome::Failed, None);
}

#[tokio::test(start_paused = true)]
async fn explicit_business_error_and_failed_cleanup_are_preserved_without_stop() {
    let mut session = Session::launch(|_, context| async move {
        assert!(context.check().is_ok());
        Execution {
            outcome: Err("独立业务失败原文".into()),
            cleanup: CleanupOutcome::Failed,
        }
    });
    session.handshake().await;
    session.send(&start(BUDGET)).await;
    let reply = session.reply().await;
    assert_failure(&reply, CleanupOutcome::Failed, Some("独立业务失败原文"));
}

#[tokio::test(start_paused = true)]
async fn context_check_prefers_local_timeout_to_cancel_and_clone_keeps_original_d() {
    let mut controlled = Controlled::begin(CleanupOutcome::Complete).await;
    controlled.session.send(&cancel()).await;
    controlled.cancelled_but_not_returned().await;
    let cloned = controlled.context.clone();
    assert!(cloned.cancellation().is_cancelled(), "克隆共享取消令牌");
    assert!(
        matches!(cloned.check(), Err(ContextError::Cancelled)),
        "D 前只取消"
    );
    advance(BUDGET).await;
    assert_eq!(Instant::now(), controlled.c0 + BUDGET);
    assert_deadline(&cloned, controlled.c0, BUDGET);
    assert!(
        matches!(cloned.check(), Err(ContextError::Timeout)),
        "数学 D 到期后 check 优先 Timeout"
    );
    assert!(matches!(
        controlled.context.check(),
        Err(ContextError::Timeout)
    ));
    let reply = controlled.finish().await;
    // 控制在 D 前已被接收；此例只证明公开 check 优先级，不重定义终态分类竞争。
    assert_failure(&reply, CleanupOutcome::Complete, None);
}

#[tokio::test(start_paused = true)]
async fn matching_cancel_before_start_returns_complete_without_handler_or_outputs() {
    for (reason, expected_error) in [
        ("cancelled", "操作已取消或宿主连接已关闭"),
        ("timeout", TIMEOUT_MESSAGE),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut session = counted_session(calls.clone());
        let c0 = session.handshake().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0, "Ready 后未启动业务");
        let mut frame = cancel();
        frame["reason"] = json!(reason);
        session.send(&frame).await;
        // 保持输入打开且从不发送 Start，避免 EOF 或业务执行掩盖启动取消分支。
        let reply = session.reply().await;
        assert_failure(&reply, CleanupOutcome::Complete, Some(expected_error));
        let response: apk_plugin_sdk::Response = serde_json::from_value(reply["response"].clone())
            .expect("公开 Response 严格解码并应用既有空产物缺省");
        assert!(response.outputs.is_empty(), "启动取消无产物");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "Start 前取消零业务调用");
        assert_eq!(Instant::now(), c0, "原帧取消不推进或重授执行预算");
    }
}

#[tokio::test(start_paused = true)]
async fn invalid_cancel_before_start_is_rejected_without_handler_or_cleanup_response() {
    let mut wrong_id = cancel();
    wrong_id["request_id"] = json!("other-context-id");
    let mut empty_id = cancel();
    empty_id["request_id"] = json!("");
    let mut old_version = cancel();
    old_version["protocol_version"] = json!(3);
    let mut future_version = cancel();
    future_version["protocol_version"] = json!(5);
    let mut unknown = cancel();
    unknown["private_reason"] = json!("ignored");
    let mut wrong_command = cancel();
    wrong_command["command"] = json!("ready");
    let mut missing_reason = cancel();
    missing_reason
        .as_object_mut()
        .expect("手工 Cancel 对象")
        .remove("reason");
    let mut bad_reason = cancel();
    bad_reason["reason"] = json!("unknown_reason");
    for frame in [
        wrong_id,
        empty_id,
        old_version,
        future_version,
        unknown,
        wrong_command,
        missing_reason,
        bad_reason,
    ] {
        // 共用拒绝辅助保持输入打开，并要求 Err、零处理器、无任何合作终态响应。
        rejected_start(frame).await;
    }
}
