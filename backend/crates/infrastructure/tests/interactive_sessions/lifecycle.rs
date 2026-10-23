use crate::support::{self, BUDGET, Fixture, observe};
use apk_domain::{Error, Executor, interactive::SessionCleanup};
use serde_json::json;
use std::{
    future::{Future, poll_fn},
    path::PathBuf,
    sync::Arc,
    task::Poll,
    time::Duration,
};
use tokio::time::{Instant, advance};
use tokio_util::sync::CancellationToken;

#[tokio::test(start_paused = true)]
async fn precancel_or_expired_original_deadline_launches_no_process_and_keeps_no_risk() {
    for cancelled in [true, false] {
        let fixture = Fixture::new();
        let cancel = CancellationToken::new();
        if cancelled {
            cancel.cancel();
        }
        let deadline = if cancelled {
            Instant::now() + BUDGET
        } else {
            Instant::now() - Duration::from_secs(1)
        };
        let mut running = fixture.launch("before-spawn", json!({"mode":"hold"}), deadline, cancel);
        assert!(
            observe(running.handle().ready(), "启动前拒绝")
                .await
                .is_err()
        );
        let exit = running.wait().await;
        assert_eq!(exit.cleanup, SessionCleanup::Complete);
        assert!(exit.process_exited);
        let failure = exit.failure.as_deref().expect("启动前失败保留");
        if cancelled {
            assert!(matches!(failure, Error::Cancelled));
        } else {
            assert!(matches!(failure, Error::Timeout));
        }
        assert!(!fixture.marker("started").exists());
        assert!(!fixture.plugin.has_unresolved_resources());
    }
}

#[tokio::test(start_paused = true)]
async fn cancel_or_timeout_before_start_confirms_direct_exit_and_allows_next_session() {
    for expire in [false, true] {
        let fixture = Fixture::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        let cancel = CancellationToken::new();
        let mut running = fixture.launch(
            "before-start",
            json!({"mode":"hold","ready_gate":true}),
            deadline,
            cancel.clone(),
        );
        let open = fixture.event("open").await;
        let pid = support::pid(&open);
        assert!(!fixture.marker("start").exists());
        if expire {
            advance(Duration::from_secs(10) + Duration::from_millis(1)).await;
        } else {
            cancel.cancel();
        }
        let exit = running.wait().await;
        assert_eq!(exit.cleanup, SessionCleanup::Complete);
        assert!(exit.process_exited);
        assert!(exit.sequence.is_none());
        assert!(exit.outcome.is_none());
        assert!(if expire {
            matches!(exit.failure.as_deref(), Some(Error::Timeout))
        } else {
            matches!(exit.failure.as_deref(), Some(Error::Cancelled))
        });
        fixture.assert_exited(pid).await;
        assert!(!fixture.marker("start").exists());
        assert!(!fixture.plugin.has_unresolved_resources());
        // 同提供者再次打开，防止已确认未启动的取消污染后续准入。
        let mut next = fixture.launch(
            "after-before-start",
            json!({"mode":"hold"}),
            Instant::now() + BUDGET,
            CancellationToken::new(),
        );
        observe(next.handle().ready(), "取消后再次准备")
            .await
            .unwrap();
        next.handle().input().cancel();
        assert_eq!(next.wait().await.cleanup, SessionCleanup::Complete);
    }
}

#[tokio::test(start_paused = true)]
async fn ready_delay_consumes_original_budget_and_timeout_is_cooperative() {
    let fixture = Fixture::new();
    let origin = Instant::now();
    let deadline = origin + Duration::from_secs(10);
    let mut running = fixture.launch(
        "original-deadline",
        json!({"mode":"hold","ready_gate":true,"cleanup_gate":true}),
        deadline,
        CancellationToken::new(),
    );
    let open = fixture.event("open").await;
    let pid = support::pid(&open);
    assert!(support::liveness::alive(pid));
    assert!(!fixture.marker("start").exists());
    advance(Duration::from_secs(3)).await;
    fixture.release("release-ready").await;
    assert_eq!(fixture.ready(&mut running).await, pid);
    let start = fixture.event("start").await;
    let remaining = start["frame"]["remaining_timeout_ns"]
        .as_u64()
        .expect("剩余整数纳秒");
    assert!(
        remaining > 0 && remaining <= 7_000_000_000,
        "三秒握手耗时从原十秒扣除：{remaining}"
    );
    advance(Duration::from_secs(7) + Duration::from_millis(1)).await;
    let control = fixture.event("cancel").await;
    assert_eq!(control["frame"]["reason"], "timeout");
    assert!(support::liveness::alive(pid));
    assert!(!running.supervisor.is_finished());
    fixture.release("release-cleanup").await;
    let exit = running.wait().await;
    assert_eq!(exit.cleanup, SessionCleanup::Complete);
    assert!(exit.process_exited);
    assert!(matches!(exit.failure.as_deref(), Some(Error::Timeout)));
    fixture.assert_exited(pid).await;
    assert!(!fixture.plugin.has_unresolved_resources());
}

#[tokio::test(start_paused = true)]
async fn cancellation_bypasses_full_output_queue_and_wait_drains_until_real_cleanup() {
    let fixture = Fixture::new();
    let mut running = fixture.launch(
        "slow-output",
        json!({"mode":"flood","cleanup_gate":true}),
        Instant::now() + BUDGET,
        CancellationToken::new(),
    );
    let pid = fixture.ready(&mut running).await;
    let mut sequence = 0;
    for _ in 0..8 {
        let chunk = observe(running.handle().recv(), "实际持续大输出")
            .await
            .unwrap();
        sequence += 1;
        assert_eq!(chunk.sequence, sequence);
        assert_eq!(chunk.bytes.len(), 8192);
    }
    // 后续不再recv；256块足够填满公开8槽并形成真实输出背压。
    let input = running.handle().input();
    input.cancel();
    let control = fixture.event("cancel").await;
    assert_eq!(control["frame"]["reason"], "cancelled");
    assert!(support::liveness::alive(pid));
    assert!(!fixture.marker("cleanup").exists());
    assert!(!running.supervisor.is_finished());
    fixture.release("release-cleanup").await;
    let exit = running.wait().await;
    assert_eq!(exit.cleanup, SessionCleanup::Complete);
    assert!(exit.process_exited);
    assert!(exit.sequence.is_some_and(|s| s > sequence));
    fixture.assert_exited(pid).await;
    assert!(!fixture.plugin.has_unresolved_resources());
}

#[tokio::test(start_paused = true)]
async fn finished_waits_for_actual_zero_exit_and_polled_wait_can_be_dropped_and_repeated() {
    let fixture = Fixture::with_outputs().await;
    let mut running = fixture.launch(
        "zero-exit",
        json!({"mode":"finished-hold","normal_gate":true}),
        Instant::now() + BUDGET,
        CancellationToken::new(),
    );
    let pid = fixture.ready(&mut running).await;
    let open = fixture.event("open").await;
    let directory = PathBuf::from(
        open["frame"]["artifacts"]["output_directory"]
            .as_str()
            .expect("真实租约工作目录"),
    );
    assert!(directory.is_dir());
    fixture.release("release-normal").await;
    fixture.event("finished").await;
    let mut waiting = Box::pin(running.handle().wait());
    poll_fn(|cx| {
        assert!(
            waiting.as_mut().poll(cx).is_pending(),
            "Finished但同PID尚存不能给Complete"
        );
        Poll::Ready(())
    })
    .await;
    assert!(support::liveness::alive(pid));
    assert!(directory.is_dir(), "实际退出前租约目录仍持有");
    drop(waiting);
    fixture.release("release-exit").await;
    let exit = running.wait().await;
    assert_eq!(exit.cleanup, SessionCleanup::Complete);
    assert!(exit.process_exited);
    fixture.assert_exited(pid).await;
    observe(
        async {
            while directory.exists() {
                tokio::task::yield_now().await;
            }
        },
        "进程实际退出后租约目录删除",
    )
    .await;
    let again = observe(running.handle().wait(), "重复wait同一终态缓存").await;
    assert!(Arc::ptr_eq(&exit, &again));
}

#[tokio::test(start_paused = true)]
async fn dropping_receive_handle_requests_cancel_but_supervisor_and_lease_wait_for_real_exit() {
    let fixture = Fixture::with_outputs().await;
    let mut running = fixture.launch(
        "drop-handle",
        json!({"mode":"hold","cleanup_gate":true}),
        Instant::now() + BUDGET,
        CancellationToken::new(),
    );
    let pid = fixture.ready(&mut running).await;
    let input = running.handle().input();
    let open = fixture.event("open").await;
    let directory = PathBuf::from(
        open["frame"]["artifacts"]["output_directory"]
            .as_str()
            .unwrap(),
    );
    running.handle.take();
    fixture.event("cancel").await;
    assert!(support::liveness::alive(pid));
    assert!(directory.is_dir());
    assert!(!running.supervisor.is_finished());
    assert!(
        observe(input.send(&[1]), "Drop后独立输入拒绝")
            .await
            .is_err()
    );
    fixture.release("release-cleanup").await;
    observe(&mut running.supervisor, "客户端丢弃后后台继续真实监督")
        .await
        .unwrap();
    fixture.assert_exited(pid).await;
    observe(
        async {
            while directory.exists() {
                tokio::task::yield_now().await;
            }
        },
        "Drop路径租约在退出后释放",
    )
    .await;
    assert!(!fixture.plugin.has_unresolved_resources());
}
