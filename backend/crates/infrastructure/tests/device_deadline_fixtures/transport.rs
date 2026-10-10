//! 真实传输使用调用方绝对期限；超时和取消不能只靠标记推断进程已经退出。

use super::support::{Fixture, OPERATION, context, finish, pid, until, wait_exited};
use apk_domain::{Error, Executor};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub(super) async fn confirmed_interruption(fixture: &Fixture, ready: &Value, reason: &str) {
    fixture.assert_cleaned(ready).await;
    assert_eq!(fixture.store.committed(), 0);
    assert!(!fixture.plugin.has_unresolved_resources());
    if fixture.protocol == 3 {
        assert_eq!(fixture.event("control").await["reason"], reason);
        assert_eq!(fixture.event("cleaned").await["reason"], reason);
        fixture.event("response_written").await;
        fixture.event("stdin_eof").await;
        assert_eq!(fixture.event("process_exit").await["code"], 0);
    } else {
        // 协议 2 只证明直接进程被回收，不能宣称合作清理了外部资源。
        assert!(!fixture.marker.join("control.json").exists());
        assert!(!fixture.marker.join("cleaned.json").exists());
    }
}

#[tokio::test]
async fn expired_context_neither_reads_artifacts_nor_starts_protocol_two_or_three() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, false, false).await;
        let deadline = Instant::now() - Duration::from_millis(1);
        let result = finish(
            fixture.plugin.execute_with_context(
                OPERATION,
                fixture.input("hold"),
                CancellationToken::new(),
                context(deadline),
            ),
            Instant::now(),
        )
        .await;
        assert!(
            matches!(result, Err(Error::Timeout)),
            "精确超时错误：{result:?}"
        );
        assert_eq!(fixture.store.reads(), 0);
        assert_eq!(fixture.store.committed(), 0);
        fixture.assert_not_started();
        assert!(!fixture.plugin.has_unresolved_resources());
    }
}

#[tokio::test]
async fn expired_context_wins_over_precancellation_without_side_effects() {
    for protocol in [2, 3] {
        for expired in [false, true] {
            let fixture = Fixture::new(protocol, false, false).await;
            let cancel = CancellationToken::new();
            cancel.cancel();
            let deadline = if expired {
                Instant::now() - Duration::from_millis(1)
            } else {
                Instant::now() + Duration::from_secs(10)
            };
            let result = finish(
                fixture.plugin.execute_with_context(
                    OPERATION,
                    fixture.input("hold"),
                    cancel,
                    context(deadline),
                ),
                Instant::now(),
            )
            .await;
            if expired {
                assert!(
                    matches!(result, Err(Error::Timeout)),
                    "已过共享截止点：{result:?}"
                );
            } else {
                assert!(
                    matches!(result, Err(Error::Cancelled)),
                    "未到期显式取消：{result:?}"
                );
            }
            assert_eq!(fixture.store.reads(), 0);
            fixture.assert_not_started();
            assert!(!fixture.plugin.has_unresolved_resources());
        }
    }
}

#[tokio::test]
async fn running_deadline_reaps_protocol_two_and_cooperatively_cleans_protocol_three() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, false, false).await;
        let deadline = Instant::now() + Duration::from_secs(4);
        let call = fixture.plugin.execute_with_context(
            OPERATION,
            fixture.input("hold"),
            CancellationToken::new(),
            context(deadline),
        );
        tokio::pin!(call);
        let ready = until(call.as_mut(), fixture.ready()).await;
        let result = finish(call.as_mut(), deadline).await;
        assert!(
            matches!(result, Err(Error::Timeout)),
            "短总期限必须产生超时：{result:?}"
        );
        confirmed_interruption(&fixture, &ready, "timeout").await;
    }
}

#[tokio::test]
async fn cancellation_after_real_ready_confirms_cleanup_and_actual_pid_exit() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, false, false).await;
        let deadline = Instant::now() + Duration::from_secs(15);
        let cancel = CancellationToken::new();
        let call = fixture.plugin.execute_with_context(
            OPERATION,
            fixture.input("hold"),
            cancel.clone(),
            context(deadline),
        );
        tokio::pin!(call);
        let ready = until(call.as_mut(), fixture.ready()).await;
        cancel.cancel();
        let result = finish(call.as_mut(), Instant::now() + Duration::from_secs(2)).await;
        assert!(
            matches!(result, Err(Error::Cancelled)),
            "清理后精确取消：{result:?}"
        );
        confirmed_interruption(&fixture, &ready, "cancelled").await;
    }
}

#[tokio::test]
async fn dropping_execution_future_reaps_pid_but_retains_unconfirmed_resource_state() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, false, false).await;
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut call = Box::pin(fixture.plugin.execute_with_context(
            OPERATION,
            fixture.input("hold"),
            CancellationToken::new(),
            context(deadline),
        ));
        let ready = until(call.as_mut(), fixture.ready()).await;
        drop(call);
        wait_exited(pid(&ready)).await;
        fixture.assert_cleaned(&ready).await;
        assert!(fixture.plugin.has_unresolved_resources());
        assert_eq!(fixture.store.committed(), 0);
    }
}

#[tokio::test]
async fn protocol_three_ignoring_timeout_keeps_cleanup_failed_despite_actual_pid_exit() {
    let fixture = Fixture::new(3, false, false).await;
    let deadline = Instant::now() + Duration::from_secs(4);
    let call = fixture.plugin.execute_with_context(
        OPERATION,
        fixture.input("ignore"),
        CancellationToken::new(),
        context(deadline),
    );
    tokio::pin!(call);
    let ready = until(call.as_mut(), fixture.ready()).await;
    let result = finish(call.as_mut(), deadline).await;
    assert!(
        matches!(result, Err(Error::CleanupFailed)),
        "无合作确认不得降为普通超时：{result:?}"
    );
    fixture.assert_cleaned(&ready).await;
    assert_eq!(fixture.event("control").await["reason"], "timeout");
    assert!(!fixture.marker.join("cleaned.json").exists());
    assert!(
        !fixture.marker.join("process_exit.json").exists(),
        "强制终止不应伪造自然退出标记"
    );
    assert!(fixture.plugin.has_unresolved_resources());
    assert_eq!(fixture.store.committed(), 0);
}

#[tokio::test]
async fn protocol_three_ignoring_cancel_keeps_cleanup_failed_despite_actual_pid_exit() {
    let fixture = Fixture::new(3, false, false).await;
    let deadline = Instant::now() + Duration::from_secs(15);
    let cancel = CancellationToken::new();
    let call = fixture.plugin.execute_with_context(
        OPERATION,
        fixture.input("ignore"),
        cancel.clone(),
        context(deadline),
    );
    tokio::pin!(call);
    let ready = until(call.as_mut(), fixture.ready()).await;
    cancel.cancel();
    let result = finish(call.as_mut(), Instant::now() + Duration::from_secs(2)).await;
    assert!(
        matches!(result, Err(Error::CleanupFailed)),
        "无合作确认不得降为普通取消：{result:?}"
    );
    fixture.assert_cleaned(&ready).await;
    assert_eq!(fixture.event("control").await["reason"], "cancelled");
    assert!(!fixture.marker.join("cleaned.json").exists());
    assert!(fixture.plugin.has_unresolved_resources());
}
