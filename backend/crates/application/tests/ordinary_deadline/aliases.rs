//! 普通旧入口继承真实目标预算；历史保留旧入口和原输入，不新建目标 Job。
use super::{
    clock::{expire_at, settle},
    executor::{ALIAS, BLOCKER, MAIN, input},
    fixture::{Fixture, deadline, timed_out},
};
use apk_domain::JobStatus;
use std::time::Duration;
use tokio::time::Instant;

#[tokio::test(start_paused = true)]
async fn ordinary_alias_inherits_target_budget_and_keeps_one_original_job() {
    for (declaration, seconds, successful_after) in [(None, 60, 20), (Some(120_000), 120, 61)] {
        let fixture = Fixture::alias(declaration).await;
        let target = fixture.app.operation(MAIN).unwrap().execution.unwrap();
        let alias = fixture.app.operation(ALIAS).unwrap().execution.unwrap();
        assert_eq!(alias, target, "别名目录必须复制目标有效预算和来源");
        assert_eq!(alias.total_timeout_ms, seconds * 1_000);
        let admitted = Instant::now();
        let original = input("alias-budget");
        let job = fixture.submit(ALIAS, "alias-budget").await;
        let call = fixture.call("alias-budget").await;
        assert_eq!(call.operation, MAIN);
        assert_eq!(call.input, original);
        assert_eq!(call.first_poll_at, admitted);
        assert_eq!(deadline(&call), admitted + Duration::from_secs(seconds));
        tokio::time::advance(Duration::from_secs(successful_after)).await;
        assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
        fixture.probe.release("alias-budget");
        let completed = fixture.terminal(&job.id).await;
        assert_eq!(completed.id, job.id);
        assert_eq!(completed.operation, ALIAS);
        assert_eq!(completed.input, original);
        assert_eq!(completed.status, JobStatus::Succeeded);
        assert_eq!(completed.result, Some(original));
        assert_eq!(fixture.store.jobs().len(), 1);
        assert_eq!(fixture.probe.calls().len(), 1);
        let events = fixture.app.events(&job.id, 0).unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.status.clone())
                .collect::<Vec<_>>(),
            vec![JobStatus::Queued, JobStatus::Running, JobStatus::Succeeded]
        );
        assert!(events.iter().all(|event| event.job_id == job.id));
        fixture.shutdown().await;
    }
}

#[tokio::test(start_paused = true)]
async fn ordinary_alias_inherited_budget_expires_while_target_worker_is_occupied() {
    let fixture = Fixture::alias(Some(30_000)).await;
    let blocker = fixture.submit(BLOCKER, "alias-owner").await;
    fixture.call("alias-owner").await;
    let admitted = Instant::now();
    let job = fixture.submit(ALIAS, "alias-queued").await;
    expire_at(admitted + Duration::from_secs(30)).await;
    let completed = fixture.terminal(&job.id).await;
    timed_out(&completed);
    assert_eq!(completed.id, job.id);
    assert_eq!(completed.operation, ALIAS);
    assert_eq!(completed.input, input("alias-queued"));
    assert!(fixture.probe.call("alias-queued").is_none());
    fixture.probe.release("alias-owner");
    assert_eq!(
        fixture.terminal(&blocker.id).await.status,
        JobStatus::Succeeded
    );
    settle().await;
    fixture.shutdown().await;
    assert_eq!(fixture.store.jobs().len(), 2);
    assert_eq!(fixture.probe.calls().len(), 1);
    assert!(fixture.probe.call("alias-queued").is_none());
}
