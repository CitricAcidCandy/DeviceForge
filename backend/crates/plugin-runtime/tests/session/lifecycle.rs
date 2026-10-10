use crate::support::{self, BUDGET, Session, observe};
use apk_plugin_sdk::{ArtifactOutput, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{
    ContextError, Execution, InvocationContext, Output, session::SessionOptions,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::oneshot,
    time::{Instant, advance},
};

struct Controlled {
    session: Session,
    context: InvocationContext,
    c0: Instant,
    signalled: oneshot::Receiver<()>,
    release: Option<oneshot::Sender<()>>,
    returned: Arc<AtomicBool>,
}
impl Controlled {
    async fn begin(cleanup: CleanupOutcome, delay: Duration) -> Self {
        let returned = Arc::new(AtomicBool::new(false));
        let marker = returned.clone();
        let (entered, context) = oneshot::channel();
        let (signal, signalled) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let options = SessionOptions {
            handshake_timeout: Duration::from_secs(30),
            ..SessionOptions::default()
        };
        let mut session =
            Session::launch(options, 128 * 1024, move |_, context, _, _| async move {
                entered.send(context.clone()).unwrap();
                context.cancellation().cancelled().await;
                signal.send(()).unwrap();
                gate.await.expect("真实清理门闩不能因处理器被丢弃而断开");
                marker.store(true, Ordering::SeqCst);
                Execution {
                    outcome: Ok(Output {
                        value: json!({"late":true}),
                        artifacts: vec![ArtifactOutput {
                            filename: "late.json".into(),
                        }],
                    }),
                    cleanup,
                }
            });
        let c0 = session.handshake().await;
        if !delay.is_zero() {
            advance(delay).await;
        }
        session.send(&support::start(BUDGET)).await;
        let context = observe(context, "处理器已进入").await.unwrap();
        assert_eq!(Instant::from_std(context.deadline()), c0 + BUDGET);
        assert!(context.check().is_ok());
        Self {
            session,
            context,
            c0,
            signalled,
            release: Some(release),
            returned,
        }
    }
    async fn stopped(&mut self) {
        observe(&mut self.signalled, "处理器实际收到取消")
            .await
            .unwrap();
        assert!(!self.returned.load(Ordering::SeqCst));
        assert!(
            !self.session.running.is_finished(),
            "未清理前运行库不能返回"
        );
        assert_eq!(Instant::from_std(self.context.deadline()), self.c0 + BUDGET);
    }
    async fn finish(&mut self) -> Value {
        self.release
            .take()
            .unwrap()
            .send(())
            .expect("处理器仍被持有");
        let events = self.session.terminal().await;
        assert!(self.returned.load(Ordering::SeqCst));
        assert_eq!(events.len(), 1);
        support::assert_order(&events, 1);
        events.into_iter().next().unwrap()
    }
}

#[tokio::test(start_paused = true)]
async fn cancel_and_host_disconnect_wait_for_real_cleanup_and_preserve_failed() {
    for cleanup in [CleanupOutcome::Complete, CleanupOutcome::Failed] {
        for disconnected in [false, true] {
            let mut controlled = Controlled::begin(cleanup, Duration::ZERO).await;
            if disconnected {
                controlled.session.shutdown_input().await;
            } else {
                controlled.session.send(&support::cancel()).await;
            }
            controlled.stopped().await;
            assert!(matches!(
                controlled.context.check(),
                Err(ContextError::Cancelled)
            ));
            support::assert_failure(&controlled.finish().await, cleanup);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn delayed_start_keeps_c0_deadline_and_expiry_waits_for_cleanup_without_rewriting_failed() {
    for cleanup in [CleanupOutcome::Complete, CleanupOutcome::Failed] {
        let mut controlled = Controlled::begin(cleanup, Duration::from_secs(5)).await;
        assert_eq!(
            Instant::from_std(controlled.context.deadline()).duration_since(Instant::now()),
            Duration::from_secs(15)
        );
        advance(Duration::from_secs(15) + Duration::from_millis(1)).await;
        controlled.stopped().await;
        assert!(matches!(
            controlled.context.check(),
            Err(ContextError::Timeout)
        ));
        let reply = controlled.finish().await;
        support::assert_failure(&reply, cleanup);
        assert!(reply["outcome"]["error"].as_str().unwrap().contains("期限"));
    }
}

#[tokio::test(start_paused = true)]
async fn zero_or_handshake_consumed_budget_never_invokes_handler() {
    for delay in [Duration::ZERO, Duration::from_secs(6)] {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let options = SessionOptions {
            handshake_timeout: Duration::from_secs(30),
            ..SessionOptions::default()
        };
        let mut session = Session::launch(options, 128 * 1024, move |_, _, _, _| {
            count.fetch_add(1, Ordering::SeqCst);
            async { Execution::complete(Ok(json!({"unexpected":true}).into())) }
        });
        session.handshake().await;
        advance(delay).await;
        session
            .send(&support::start(if delay.is_zero() {
                Duration::ZERO
            } else {
                Duration::from_secs(5)
            }))
            .await;
        let events = session.terminal().await;
        assert_eq!(events.len(), 1);
        support::assert_failure(&events[0], CleanupOutcome::Complete);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "不重新授予 Start 接收点的相对期限"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn bad_running_frames_cancel_and_wait_for_cleanup() {
    let mut wrong_id = support::cancel();
    wrong_id["session_id"] = json!("another");
    let mut wrong_version = support::cancel();
    wrong_version["protocol_version"] = json!(4);
    let mut unknown = support::cancel();
    unknown["renew"] = json!(true);
    let mut malformed_enum = support::cancel();
    malformed_enum["reason"] = json!({"cancelled":null});
    for frame in [
        wrong_id,
        wrong_version,
        unknown,
        malformed_enum,
        support::start(BUDGET),
    ] {
        let mut controlled = Controlled::begin(CleanupOutcome::Failed, Duration::ZERO).await;
        controlled.session.send(&frame).await;
        controlled.stopped().await;
        support::assert_failure(&controlled.finish().await, CleanupOutcome::Failed);
    }
    for bytes in [b"{\n".as_slice(), b"{\"protocol_version\":5".as_slice()] {
        let mut controlled = Controlled::begin(CleanupOutcome::Failed, Duration::ZERO).await;
        controlled.session.send_bytes(bytes).await;
        if bytes.last() != Some(&b'\n') {
            controlled.session.shutdown_input().await;
        }
        controlled.stopped().await;
        support::assert_failure(&controlled.finish().await, CleanupOutcome::Failed);
    }
}

#[tokio::test(start_paused = true)]
async fn explicit_business_error_and_failed_cleanup_remain_original_without_cancel() {
    let mut session = Session::launch(SessionOptions::default(), 128 * 1024, |_, _, _, _| async {
        Execution {
            outcome: Err("原业务失败".into()),
            cleanup: CleanupOutcome::Failed,
        }
    });
    session.begin().await;
    let events = session.terminal().await;
    support::assert_failure(&events[0], CleanupOutcome::Failed);
    assert_eq!(events[0]["outcome"]["error"], "原业务失败");
}

#[tokio::test(start_paused = true)]
async fn terminal_transport_grace_is_independent_and_cannot_claim_host_confirmation() {
    let (entered, context) = oneshot::channel();
    let (release, gate) = oneshot::channel();
    let returned = Arc::new(AtomicBool::new(false));
    let marker = returned.clone();
    let mut session = Session::launch(
        SessionOptions::default(),
        128 * 1024,
        move |_, context, _, _| async move {
            entered.send(context).unwrap();
            gate.await.unwrap();
            marker.store(true, Ordering::SeqCst);
            Execution {
                outcome: Err("清理未确认".into()),
                cleanup: CleanupOutcome::Failed,
            }
        },
    );
    let c0 = session.begin().await;
    let context = observe(context, "取得原业务上下文").await.unwrap();
    session.write_gate.stop();
    release.send(()).unwrap();
    observe(
        async {
            while !returned.load(Ordering::SeqCst) || !session.write_gate.is_waiting() {
                tokio::task::yield_now().await;
            }
        },
        "处理器真实返回且终态写入已Pending",
    )
    .await;
    assert!(!session.running.is_finished());
    assert_eq!(Instant::from_std(context.deadline()), c0 + BUDGET);
    advance(Duration::from_secs(2) + Duration::from_millis(1)).await;
    let error = observe(&mut session.running, "终态宽限结束")
        .await
        .unwrap()
        .expect_err("未写出终态不能报告传输成功");
    assert!(error.contains("宽限"));
    assert_eq!(Instant::from_std(context.deadline()), c0 + BUDGET);
    assert!(
        context.check().is_ok(),
        "两秒终态传输宽限不改二十秒业务期限"
    );
    let mut bytes = Vec::new();
    use tokio::io::AsyncReadExt;
    observe(session.reader.read_to_end(&mut bytes), "宽限失败后输出关闭")
        .await
        .unwrap();
    assert!(bytes.is_empty());
}

#[tokio::test(start_paused = true)]
async fn oversized_terminal_and_abnormal_error_are_bounded_and_keep_failed_cleanup() {
    for case in 0..3 {
        let mut session = Session::launch(
            SessionOptions::default(),
            2 * 1024 * 1024,
            move |_, _, _, _| async move {
                let outcome = match case {
                    0 => Ok(json!({"large":"中".repeat(400_000)}).into()),
                    1 => Err("  \n\t".into()),
                    _ => Err("中文".repeat(1000)),
                };
                Execution {
                    outcome,
                    cleanup: CleanupOutcome::Failed,
                }
            },
        );
        session.begin().await;
        let events = session.terminal().await;
        assert_eq!(events.len(), 1);
        support::assert_failure(&events[0], CleanupOutcome::Failed);
        let error = events[0]["outcome"]["error"].as_str().unwrap();
        assert!(error.len() <= 4096 && !error.trim().is_empty());
        if case == 0 {
            assert!(error.contains("1 MiB"));
        }
        if case == 2 {
            assert_eq!(error.len(), 4095);
            assert!(error.chars().all(|c| c == '中' || c == '文'));
        }
        assert!(serde_json::to_vec(&events[0]).unwrap().len() < 1024 * 1024);
    }
}

struct FutureDrop(Arc<AtomicBool>);
impl Drop for FutureDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[tokio::test(start_paused = true)]
async fn aborting_actually_started_runtime_cancels_context_without_a_cleanup_confirmation() {
    let (entered, context) = oneshot::channel();
    let dropped = Arc::new(AtomicBool::new(false));
    let marker = dropped.clone();
    let mut session = Session::launch(
        SessionOptions::default(),
        128 * 1024,
        move |_, context, _, _| async move {
            let _drop_marker = FutureDrop(marker);
            entered.send(context).unwrap();
            std::future::pending::<Execution>().await
        },
    );
    session.begin().await;
    let context = observe(context, "处理器 Future 已真实进入").await.unwrap();
    assert!(!context.cancellation().is_cancelled());
    assert!(!dropped.load(Ordering::SeqCst));
    session.running.abort();
    assert!(
        observe(&mut session.running, "中止运行任务")
            .await
            .expect_err("任务被中止")
            .is_cancelled()
    );
    assert!(
        context.cancellation().is_cancelled(),
        "DropGuard 撤销 I/O 准入"
    );
    assert!(dropped.load(Ordering::SeqCst));
    let mut bytes = Vec::new();
    use tokio::io::AsyncReadExt;
    observe(
        session.reader.read_to_end(&mut bytes),
        "运行任务中止后关闭管道",
    )
    .await
    .unwrap();
    assert!(
        bytes.is_empty(),
        "业务 Future 丢弃不能伪造任何 Finished 清理确认"
    );
}
