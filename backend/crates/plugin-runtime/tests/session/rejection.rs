use crate::support::{self, BUDGET, Session, observe};
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::{
    Execution,
    session::{SessionOptions, serve_session_io},
};
use serde_json::{Value, json};
use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, ReadBuf},
    sync::oneshot,
    time::advance,
};

fn counted(calls: Arc<AtomicUsize>) -> Session {
    Session::launch(SessionOptions::default(), 128 * 1024, move |_, _, _, _| {
        calls.fetch_add(1, Ordering::SeqCst);
        async { Execution::complete(Ok(json!({"unexpected":true}).into())) }
    })
}

#[tokio::test(start_paused = true)]
async fn invalid_open_versions_identity_operation_and_unknown_fields_never_emit_ready() {
    let mut cases = Vec::new();
    for version in [1, 2, 3, 4, 6] {
        let mut frame = support::open();
        frame["protocol_version"] = json!(version);
        cases.push(frame);
    }
    for id in ["".to_owned(), "中".repeat(43)] {
        let mut frame = support::open();
        frame["session_id"] = json!(id);
        cases.push(frame);
    }
    for operation in ["".to_owned(), "x".repeat(129)] {
        let mut frame = support::open();
        frame["operation"] = json!(operation);
        cases.push(frame);
    }
    let mut unknown = support::open();
    unknown["renew"] = json!(true);
    cases.push(unknown);
    let mut command = support::open();
    command["command"] = json!({"open":null});
    cases.push(command);
    for frame in cases {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut session = counted(calls.clone());
        session.send(&frame).await;
        session.rejected().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn invalid_start_identity_versions_budget_and_unknown_fields_never_invoke_handler() {
    let mut cases = Vec::new();
    let mut id = support::start(BUDGET);
    id["session_id"] = json!("other");
    cases.push(id);
    let mut version = support::start(BUDGET);
    version["protocol_version"] = json!(4);
    cases.push(version);
    let mut unknown = support::start(BUDGET);
    unknown["new_budget"] = json!(1);
    cases.push(unknown);
    let mut command = support::start(BUDGET);
    command["command"] = json!("open");
    cases.push(command);
    for budget in [
        json!(-1),
        json!(null),
        json!(1.5),
        json!("100"),
        json!(3_600_000_000_001u64),
    ] {
        let mut frame = support::start(BUDGET);
        frame["remaining_timeout_ns"] = budget;
        cases.push(frame);
    }
    for frame in cases {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut session = counted(calls.clone());
        session.handshake().await;
        session.send(&frame).await;
        session.rejected().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn bounded_or_incomplete_handshake_frames_are_rejected_before_handler() {
    let mut initial = serde_json::to_vec(&support::open()).unwrap();
    let incomplete = initial.clone();
    initial.push(b'\n');
    let mut oversized_start = initial.clone();
    oversized_start.extend(vec![b'x'; 4097]);
    oversized_start.push(b'\n');
    let mut incomplete_start = initial;
    incomplete_start.extend_from_slice(b"{\"protocol_version\":5");
    for bytes in [
        incomplete,
        vec![b'x'; 512 * 1024 + 1],
        oversized_start,
        incomplete_start,
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut output = Vec::new();
        let result = observe(
            serve_session_io(
                bytes.as_slice(),
                &mut output,
                SessionOptions::default(),
                move |_, _, _, _| {
                    count.fetch_add(1, Ordering::SeqCst);
                    async { Execution::complete(Ok(Value::Null.into())) }
                },
            ),
            "拒绝无换行或超限握手",
        )
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!String::from_utf8_lossy(&output).contains("finished"));
    }
}

#[tokio::test(start_paused = true)]
async fn handshake_transport_budget_is_bounded_before_open_and_after_ready() {
    for after_ready in [false, true] {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut session = counted(calls.clone());
        if after_ready {
            session.handshake().await;
        } else {
            observe(tokio::task::yield_now(), "握手任务先实际轮询再推进时钟").await;
        }
        advance(Duration::from_secs(5) + Duration::from_millis(1)).await;
        session.rejected().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn repeated_eof_and_input_after_eof_cancel_instead_of_reopening_input() {
    for invalid in [support::eof(), support::input(&[1])] {
        let (seen, saw_eof) = oneshot::channel();
        let (stopped, stop) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let mut session = Session::launch(
            SessionOptions::default(),
            128 * 1024,
            move |_, context, mut input, _| async move {
                assert!(input.recv().await.unwrap().is_none());
                seen.send(()).unwrap();
                context.cancellation().cancelled().await;
                stopped.send(()).unwrap();
                gate.await.unwrap();
                Execution {
                    outcome: Ok(json!({"late":true}).into()),
                    cleanup: CleanupOutcome::Failed,
                }
            },
        );
        session.begin().await;
        session.send(&support::eof()).await;
        observe(saw_eof, "首次EOF实际交付").await.unwrap();
        session.send(&invalid).await;
        observe(stop, "EOF后非法控制仍通知清理").await.unwrap();
        assert!(!session.running.is_finished());
        release.send(()).unwrap();
        let events = session.terminal().await;
        support::assert_failure(&events[0], CleanupOutcome::Failed);
    }
}

struct MustNotRead;
impl AsyncRead for MustNotRead {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        panic!("无效选项必须在首次读取前拒绝")
    }
}

#[tokio::test(start_paused = true)]
async fn invalid_options_are_rejected_before_reading_any_frame() {
    let options = SessionOptions {
        channel_capacity: 0,
        ..SessionOptions::default()
    };
    let result = serve_session_io(
        MustNotRead,
        tokio::io::sink(),
        options,
        |_, _, _, _| async { panic!("非法选项不得启动处理器") },
    )
    .await;
    assert!(result.is_err());
}
