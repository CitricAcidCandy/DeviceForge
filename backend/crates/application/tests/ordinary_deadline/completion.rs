//! 成功资格前的存储槽等待，与资格已取得后的不可中断提交分别验收。
use super::{
    clock::{expire_at, paused_future, paused_until, poll_once, settle},
    executor::{ALIAS, MAIN, input},
    fixture::{Fixture, deadline, timed_out},
};
use apk_domain::JobStatus;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;

async fn dropped_cleanup_risk_waiting_for_terminal_slot(expired: bool) {
    let fixture = Fixture::alias(Some(30_000)).await;
    let label = if expired {
        "drop-after-deadline"
    } else {
        "drop-after-cancel"
    };
    fixture.probe.fail_on_drop(label);
    let job = fixture.submit(ALIAS, label).await;
    let call = fixture.call(label).await;
    let readers = fixture.fill_storage().await;
    if expired {
        expire_at(deadline(&call)).await;
    } else {
        // 执行器收到的真实token发出取消，不提前取得终态存储资格。
        call.cancel.cancel();
    }
    paused_until("外围清理已收到取消", || {
        call.cancel.is_cancelled().then_some(())
    })
    .await;
    settle().await;
    tokio::time::advance(Duration::from_millis(2_001)).await;
    paused_until("有限清理到期后真实Future已释放", || {
        fixture.probe.ended(label).then_some(())
    })
    .await;
    assert!(
        !fixture.probe.returned(label),
        "不能用正常返回替代真实Drop路径"
    );
    assert!(fixture.cleanup_failed(), "Drop守卫必须留下粘性未确认风险");
    assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
    if !expired {
        expire_at(deadline(&call)).await;
    }
    fixture.drain_storage(readers).await;
    let failed = fixture.terminal(&job.id).await;
    assert_eq!(failed.status, JobStatus::Failed);
    assert_eq!(
        failed.error,
        Some(apk_domain::Error::CleanupFailed.to_string())
    );
    assert!(failed.result.is_none());
    assert!(fixture.cleanup_failed());
    fixture.shutdown().await;
    assert!(fixture.cleanup_failed());
}

#[tokio::test(start_paused = true)]
async fn dropped_cleanup_risk_after_deadline_is_preserved_before_terminal_storage() {
    dropped_cleanup_risk_waiting_for_terminal_slot(true).await;
}

#[tokio::test(start_paused = true)]
async fn dropped_cleanup_risk_after_cancel_survives_later_deadline_and_storage_wait() {
    dropped_cleanup_risk_waiting_for_terminal_slot(false).await;
}

#[tokio::test(start_paused = true)]
async fn cleanup_failure_during_deadline_drain_is_not_discarded_by_outer_timeout() {
    let fixture = Fixture::alias(Some(30_000)).await;
    let label = "cleanup-failed-during-deadline-drain";
    fixture.probe.fail_on_release(label);
    let job = fixture.submit(ALIAS, label).await;
    let call = fixture.call(label).await;
    expire_at(deadline(&call)).await;
    paused_until("到期清理已发出取消", || {
        call.cancel.is_cancelled().then_some(())
    })
    .await;
    fixture.probe.release(label);
    let failed = fixture.terminal(&job.id).await;
    assert_eq!(failed.status, JobStatus::Failed);
    assert_eq!(
        failed.error,
        Some(apk_domain::Error::CleanupFailed.to_string())
    );
    assert!(fixture.cleanup_failed());
    fixture.shutdown().await;
    assert!(fixture.cleanup_failed());
}

#[tokio::test(start_paused = true)]
async fn cleanup_failure_waiting_for_terminal_slot_preserves_risk_after_deadline() {
    let fixture = Fixture::alias(Some(30_000)).await;
    let label = "cleanup-failed-before-terminal-slot";
    fixture.probe.fail_on_release(label);
    let job = fixture.submit(ALIAS, label).await;
    let call = fixture.call(label).await;
    let readers = fixture.fill_storage().await;
    fixture.probe.release(label);
    paused_until("执行器已返回类型化清理失败", || {
        fixture.probe.returned(label).then_some(())
    })
    .await;
    assert!(fixture.cleanup_failed());
    assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
    expire_at(deadline(&call)).await;
    fixture.drain_storage(readers).await;
    let failed = fixture.terminal(&job.id).await;
    assert_eq!(failed.status, JobStatus::Failed);
    assert_eq!(
        failed.error,
        Some(apk_domain::Error::CleanupFailed.to_string())
    );
    assert!(fixture.cleanup_failed(), "写入失败终态不得清除owner风险");
    fixture.shutdown().await;
    assert!(fixture.cleanup_failed());
}

#[tokio::test(start_paused = true)]
async fn claimed_cancellation_transaction_cannot_be_overtaken_by_late_timeout() {
    let fixture = Fixture::new(Some(30_000), 1);
    fixture.store.cancellation_started.close();
    let job = fixture.submit(MAIN, "cancel-claim-before-expiry").await;
    let call = fixture.call("cancel-claim-before-expiry").await;
    let app = fixture.app.clone();
    let id = job.id.clone();
    let cancelling = tokio::task::spawn_blocking(move || app.cancel(&id));
    paused_until("取消资格已取得且存储事务被暂停", || {
        (fixture.store.cancellation_started.entered() == 1).then_some(())
    })
    .await;
    assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
    expire_at(deadline(&call)).await;
    paused_until("执行器收到到期或取消信号", || {
        call.cancel.is_cancelled().then_some(())
    })
    .await;
    fixture.probe.release("cancel-claim-before-expiry");
    // 显式取消的两秒清理可能先于本次三十秒推进开始，外围可合法丢弃Future。
    paused_until("被取消的执行器Future已返回或被丢弃", || {
        fixture
            .probe
            .ended("cancel-claim-before-expiry")
            .then_some(())
    })
    .await;
    settle().await;
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Failed), 0);
    assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
    fixture.store.cancellation_started.release();
    let cancelled = paused_future("取消事务排空", Box::pin(cancelling).as_mut()).await;
    assert_eq!(cancelled.unwrap().unwrap().status, JobStatus::Cancelled);
    fixture.shutdown().await;
    let terminal = fixture.app.get(&job.id).unwrap();
    assert_eq!(terminal.status, JobStatus::Cancelled);
    assert!(terminal.error.is_none());
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Failed), 0);
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Cancelled), 1);
}

#[tokio::test(start_paused = true)]
async fn waiting_for_success_storage_slot_past_deadline_cannot_commit_success() {
    let fixture = Fixture::new(Some(30_000), 1);
    let job = fixture.submit(MAIN, "success-slot-expired").await;
    let call = fixture.call("success-slot-expired").await;
    let readers = fixture.fill_storage().await;
    fixture.probe.release("success-slot-expired");
    paused_until("执行器返回业务结果", || {
        fixture.probe.returned("success-slot-expired").then_some(())
    })
    .await;
    settle().await;
    assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Succeeded), 0);
    expire_at(deadline(&call)).await;
    fixture.drain_storage(readers).await;
    timed_out(&fixture.terminal(&job.id).await);
    fixture.shutdown().await;
    assert_eq!(
        fixture.store.attempts(&job.id, JobStatus::Succeeded),
        0,
        "成功资格必须在取得终态存储槽之后重新判断"
    );
    assert_eq!(fixture.probe.calls().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn cancelling_before_success_storage_slot_wins_and_deadline_cannot_rewrite_it() {
    let fixture = Fixture::new(Some(30_000), 1);
    let job = fixture.submit(MAIN, "success-slot-cancelled").await;
    let call = fixture.call("success-slot-cancelled").await;
    let readers = fixture.fill_storage().await;
    fixture.probe.release("success-slot-cancelled");
    paused_until("取消前执行器返回业务结果", || {
        fixture
            .probe
            .returned("success-slot-cancelled")
            .then_some(())
    })
    .await;
    settle().await;
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Succeeded), 0);
    assert_eq!(
        fixture.app.cancel(&job.id).unwrap().status,
        JobStatus::Cancelled
    );
    expire_at(deadline(&call)).await;
    fixture.drain_storage(readers).await;
    fixture.shutdown().await;
    let completed = fixture.app.get(&job.id).unwrap();
    assert_eq!(completed.status, JobStatus::Cancelled);
    assert!(completed.result.is_none());
    assert!(completed.error.is_none());
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Succeeded), 0);
    let terminal_events = fixture
        .app
        .events(&job.id, 0)
        .unwrap()
        .into_iter()
        .filter(|event| event.status.is_terminal())
        .collect::<Vec<_>>();
    assert_eq!(terminal_events.len(), 1);
    assert_eq!(terminal_events[0].status, JobStatus::Cancelled);
}

#[tokio::test(start_paused = true)]
async fn already_claimed_success_transaction_may_converge_after_deadline() {
    let fixture = Fixture::new(Some(30_000), 1);
    fixture.store.success_started.close();
    let job = fixture.submit(MAIN, "claimed-expired").await;
    let call = fixture.call("claimed-expired").await;
    fixture.probe.release("claimed-expired");
    paused_until("已取得资格并进入成功存储事务", || {
        (fixture.store.success_started.entered() == 1).then_some(())
    })
    .await;
    assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
    expire_at(deadline(&call)).await;
    assert_eq!(fixture.store.success_started.exited(), 0);
    fixture.store.success_started.release();
    let completed = fixture.terminal(&job.id).await;
    assert_eq!(completed.status, JobStatus::Succeeded);
    assert_eq!(completed.result, Some(input("claimed-expired")));
    assert!(completed.error.is_none());
    fixture.shutdown().await;
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Succeeded), 1);
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Failed), 0);
    assert_eq!(
        fixture
            .app
            .events(&job.id, 0)
            .unwrap()
            .iter()
            .filter(|event| event.status.is_terminal())
            .count(),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn cancel_after_success_claim_waits_for_transaction_and_returns_succeeded() {
    let fixture = Fixture::new(Some(30_000), 1);
    fixture.store.success_started.close();
    let job = fixture.submit(MAIN, "claimed-cancelled").await;
    fixture.call("claimed-cancelled").await;
    fixture.probe.release("claimed-cancelled");
    paused_until("取消前成功事务已开始", || {
        (fixture.store.success_started.entered() == 1).then_some(())
    })
    .await;
    let began_cancel = Arc::new(AtomicBool::new(false));
    let began = began_cancel.clone();
    let app = fixture.app.clone();
    let id = job.id.clone();
    // 公开同步 cancel 可以等待已取得资格的提交，不让这种等待阻塞 Tokio 线程。
    let cancelling = tokio::task::spawn_blocking(move || {
        began.store(true, Ordering::SeqCst);
        app.cancel(&id)
    });
    tokio::pin!(cancelling);
    paused_until("取消线程到达公开入口", || {
        began_cancel.load(Ordering::SeqCst).then_some(())
    })
    .await;
    settle().await;
    assert!(
        poll_once(cancelling.as_mut()).await.is_none(),
        "事务未放行时取消不能抢写终态"
    );
    assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Cancelled), 0);
    fixture.store.success_started.release();
    let cancelled_response = paused_future("取消等待成功事务收敛", cancelling.as_mut())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancelled_response.status, JobStatus::Succeeded);
    assert_eq!(cancelled_response.result, Some(input("claimed-cancelled")));
    assert_eq!(fixture.terminal(&job.id).await.status, JobStatus::Succeeded);
    fixture.shutdown().await;
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Succeeded), 1);
    let terminal_events = fixture
        .app
        .events(&job.id, 0)
        .unwrap()
        .into_iter()
        .filter(|event| event.status.is_terminal())
        .collect::<Vec<_>>();
    assert_eq!(terminal_events.len(), 1);
    assert_eq!(terminal_events[0].status, JobStatus::Succeeded);
}

#[tokio::test(start_paused = true)]
async fn committed_cancelled_terminal_survives_later_deadline_and_executor_release() {
    let fixture = Fixture::new(Some(30_000), 1);
    let admitted = Instant::now();
    let job = fixture.submit(MAIN, "cancel-cas").await;
    let call = fixture.call("cancel-cas").await;
    assert_eq!(deadline(&call), admitted + Duration::from_secs(30));
    assert_eq!(
        fixture.app.cancel(&job.id).unwrap().status,
        JobStatus::Cancelled
    );
    fixture.probe.release("cancel-cas");
    expire_at(deadline(&call)).await;
    fixture.shutdown().await;
    let completed = fixture.app.get(&job.id).unwrap();
    assert_eq!(completed.status, JobStatus::Cancelled);
    assert!(completed.result.is_none());
    assert!(completed.error.is_none());
    let terminal_events = fixture
        .app
        .events(&job.id, 0)
        .unwrap()
        .into_iter()
        .filter(|event| event.status.is_terminal())
        .collect::<Vec<_>>();
    assert_eq!(terminal_events.len(), 1);
    assert_eq!(terminal_events[0].status, JobStatus::Cancelled);
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Succeeded), 0);
}
