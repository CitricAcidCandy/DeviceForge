//! 准入在首次等待存储槽前；创建尚未开始与不可中断创建分别观察。
use super::{
    clock::{expire_at, paused_future, paused_until, poll_once, settle},
    executor::{MAIN, input},
    fixture::{Fixture, deadline, timed_out},
};
use apk_domain::{Error, JobStatus};
use std::time::Duration;
use tokio::time::Instant;

#[tokio::test(start_paused = true)]
async fn storage_pool_wait_expiry_creates_no_job_and_never_polls_executor() {
    let fixture = Fixture::new(Some(30_000), 1);
    let readers = fixture.fill_storage().await;
    let admitted = Instant::now();
    let submitting = fixture.app.submit_async(MAIN.into(), input("pool-expired"));
    tokio::pin!(submitting);
    assert!(poll_once(submitting.as_mut()).await.is_none());
    assert_eq!(fixture.store.creating.entered(), 0);
    expire_at(admitted + Duration::from_secs(30)).await;
    let result = paused_future("未取得存储槽的提交到期", submitting.as_mut()).await;
    assert!(matches!(result, Err(Error::Timeout)));
    assert!(fixture.store.jobs().is_empty());
    assert!(fixture.probe.calls().is_empty());
    fixture.drain_storage(readers).await;
    settle().await;
    assert_eq!(
        fixture.store.creating.entered(),
        0,
        "不能在到期后重新排队创建"
    );
    assert!(fixture.store.jobs().is_empty());
    assert!(fixture.probe.calls().is_empty());
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn storage_pool_wait_is_deducted_before_execute_context_is_created() {
    let fixture = Fixture::new(Some(30_000), 1);
    let readers = fixture.fill_storage().await;
    let admitted = Instant::now();
    let original = input("pool-remaining");
    let submitting = fixture.app.submit_async(MAIN.into(), original.clone());
    tokio::pin!(submitting);
    assert!(poll_once(submitting.as_mut()).await.is_none());
    tokio::time::advance(Duration::from_secs(20)).await;
    assert_eq!(fixture.store.creating.entered(), 0);
    fixture.drain_storage(readers).await;
    let job = paused_future("存储槽释放后的提交", submitting.as_mut())
        .await
        .unwrap();
    let call = fixture.call("pool-remaining").await;
    assert_eq!(call.first_poll_at, admitted + Duration::from_secs(20));
    assert_eq!(deadline(&call), admitted + Duration::from_secs(30));
    assert_eq!(
        deadline(&call).duration_since(call.first_poll_at),
        Duration::from_secs(10)
    );
    assert_eq!(call.input, original);
    fixture.probe.release("pool-remaining");
    assert_eq!(fixture.terminal(&job.id).await.status, JobStatus::Succeeded);
    assert_eq!(fixture.store.creating.entered(), 1);
    assert_eq!(fixture.probe.calls().len(), 1);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn begun_create_after_deadline_is_compensated_without_orphan_or_execution() {
    let fixture = Fixture::new(Some(30_000), 1);
    fixture.store.creating.close();
    let admitted = Instant::now();
    let original = input("create-expired");
    let submitting = fixture.app.submit_async(MAIN.into(), original.clone());
    tokio::pin!(submitting);
    assert!(poll_once(submitting.as_mut()).await.is_none());
    paused_until("不可中断创建已开始", || {
        (fixture.store.creating.entered() == 1).then_some(())
    })
    .await;
    expire_at(admitted + Duration::from_secs(30)).await;
    let early = poll_once(submitting.as_mut()).await;
    if let Some(result) = &early {
        assert!(matches!(result, Err(Error::Timeout)));
    }
    assert_eq!(fixture.store.creating.exited(), 0);
    assert!(fixture.store.jobs().is_empty());
    assert!(fixture.probe.calls().is_empty());
    fixture.store.creating.release();
    let result = match early {
        Some(result) => result,
        None => paused_future("实际创建排空后的提交结果", submitting.as_mut()).await,
    };
    assert!(matches!(result, Err(Error::Timeout)));
    let job = paused_until("创建到期补偿终态", || {
        let jobs = fixture.store.jobs();
        (jobs.len() == 1 && jobs[0].status.is_terminal()).then(|| jobs[0].clone())
    })
    .await;
    timed_out(&job);
    assert_eq!(job.operation, MAIN);
    assert_eq!(job.input, original);
    assert_eq!(fixture.store.creating.entered(), 1);
    assert_eq!(fixture.store.creating.exited(), 1);
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Running), 0);
    assert!(fixture.probe.calls().is_empty());
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn dropping_submit_before_storage_slot_never_starts_creation_later() {
    let fixture = Fixture::new(Some(30_000), 1);
    let readers = fixture.fill_storage().await;
    // Box 拥有整个 Future，drop 不只是丢弃 Pin 引用。
    let mut submitting = Box::pin(
        fixture
            .app
            .submit_async(MAIN.into(), input("dropped-admission")),
    );
    assert!(poll_once(submitting.as_mut()).await.is_none());
    drop(submitting);
    settle().await;
    assert_eq!(fixture.store.creating.entered(), 0);
    fixture.drain_storage(readers).await;
    fixture.shutdown().await;
    assert_eq!(fixture.store.creating.entered(), 0);
    assert!(fixture.store.jobs().is_empty());
    assert!(fixture.probe.calls().is_empty());
}
