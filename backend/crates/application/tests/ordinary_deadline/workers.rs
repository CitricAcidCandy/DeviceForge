//! 工作槽排队与 Running 存储返回不能刷新期限，也不能在拒绝后首次 poll。
use super::{
    clock::{expire_at, paused_until, settle},
    executor::{BLOCKER, MAIN},
    fixture::{Fixture, deadline, timed_out},
};
use apk_domain::{JobStatus, OperationExecutionSource};
use std::time::Duration;
use tokio::time::Instant;

#[tokio::test(start_paused = true)]
async fn queued_worker_expiry_never_polls_even_after_worker_release() {
    let fixture = Fixture::new(Some(30_000), 1);
    let blocker = fixture.submit(BLOCKER, "worker-owner").await;
    fixture.call("worker-owner").await;
    let admitted = Instant::now();
    let job = fixture.submit(MAIN, "worker-expired").await;
    assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Queued);
    expire_at(admitted + Duration::from_secs(30)).await;
    timed_out(&fixture.terminal(&job.id).await);
    assert!(fixture.probe.call("worker-expired").is_none());
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Running), 0);
    fixture.probe.release("worker-owner");
    assert_eq!(
        fixture.terminal(&blocker.id).await.status,
        JobStatus::Succeeded
    );
    settle().await;
    assert!(fixture.probe.call("worker-expired").is_none());
    assert_eq!(fixture.probe.calls().len(), 1);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn queued_worker_receives_original_deadline_with_only_remaining_budget() {
    let fixture = Fixture::new(Some(30_000), 1);
    let blocker = fixture.submit(BLOCKER, "queue-owner").await;
    fixture.call("queue-owner").await;
    let admitted = Instant::now();
    let job = fixture.submit(MAIN, "queue-remaining").await;
    tokio::time::advance(Duration::from_secs(20)).await;
    assert!(fixture.probe.call("queue-remaining").is_none());
    fixture.probe.release("queue-owner");
    let call = fixture.call("queue-remaining").await;
    assert_eq!(call.first_poll_at, admitted + Duration::from_secs(20));
    assert_eq!(deadline(&call), admitted + Duration::from_secs(30));
    assert_eq!(
        deadline(&call).duration_since(call.first_poll_at),
        Duration::from_secs(10)
    );
    expire_at(deadline(&call)).await;
    // 执行器故意忽略取消；先确认宿主取消，再放行清理，暂停时钟不隐式推进两秒窗口。
    paused_until(
        "宿主已经向忽略取消的执行器发出取消",
        || call.cancel.is_cancelled().then_some(()),
    )
    .await;
    assert!(!fixture.probe.returned("queue-remaining"));
    fixture.probe.release("queue-remaining");
    timed_out(&fixture.terminal(&job.id).await);
    assert_eq!(
        fixture.terminal(&blocker.id).await.status,
        JobStatus::Succeeded
    );
    assert_eq!(fixture.probe.calls().len(), 2);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn expired_after_running_write_never_first_polls_executor() {
    let fixture = Fixture::new(Some(30_000), 1);
    fixture.store.running_written.close();
    let admitted = Instant::now();
    let job = fixture.submit(MAIN, "running-expired").await;
    paused_until("Running 已写入且存储返回被门闩暂停", || {
        (fixture.store.running_written.entered() == 1).then_some(())
    })
    .await;
    assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
    assert!(fixture.probe.calls().is_empty());
    expire_at(admitted + Duration::from_secs(30)).await;
    assert_eq!(fixture.store.running_written.exited(), 0);
    fixture.store.running_written.release();
    timed_out(&fixture.terminal(&job.id).await);
    assert!(
        fixture.probe.calls().is_empty(),
        "Running 返回后到期不得首次 poll"
    );
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn cancelled_after_running_write_never_first_polls_executor() {
    let fixture = Fixture::new(Some(30_000), 1);
    fixture.store.running_written.close();
    let job = fixture.submit(MAIN, "running-cancelled").await;
    paused_until("取消前 Running 已真实写入", || {
        (fixture.store.running_written.entered() == 1).then_some(())
    })
    .await;
    assert_eq!(
        fixture.app.cancel(&job.id).unwrap().status,
        JobStatus::Cancelled
    );
    fixture.store.running_written.release();
    settle().await;
    assert_eq!(fixture.terminal(&job.id).await.status, JobStatus::Cancelled);
    assert!(fixture.probe.calls().is_empty());
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Succeeded), 0);
    fixture.shutdown().await;
    assert!(
        fixture.probe.calls().is_empty(),
        "应用排空后仍不得出现晚到首 poll"
    );
}

#[tokio::test(start_paused = true)]
async fn registered_default_and_declared_budget_are_the_actual_context_budget() {
    for (declaration, seconds, source, successful_after) in [
        (None, 60, OperationExecutionSource::Default, 20),
        (Some(120_000), 120, OperationExecutionSource::Declared, 61),
    ] {
        let fixture = Fixture::new(declaration, 1);
        let definition = fixture.app.operation(MAIN).unwrap();
        let effective = definition.execution.unwrap();
        assert_eq!(effective.api_version, 1);
        assert_eq!(effective.total_timeout_ms, seconds * 1_000);
        assert_eq!(effective.source, source);
        let admitted = Instant::now();
        let job = fixture.submit(MAIN, "directory-budget").await;
        let call = fixture.call("directory-budget").await;
        assert_eq!(call.operation, MAIN);
        assert_eq!(call.first_poll_at, admitted);
        assert_eq!(deadline(&call), admitted + Duration::from_secs(seconds));
        tokio::time::advance(Duration::from_secs(successful_after)).await;
        assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
        assert_eq!(fixture.probe.calls().len(), 1);
        fixture.probe.release("directory-budget");
        assert_eq!(fixture.terminal(&job.id).await.status, JobStatus::Succeeded);
        fixture.shutdown().await;
    }
}
