//! 同一绝对期限与门禁前排队用例。
use crate::fixtures::executor::{Invocation, Provider, observed};
use crate::fixtures::store::Phase;
use crate::fixtures::{ALIAS, Fixture, code, guarded, same_json, success, turns, until};
use apk_domain::{JobStatus, JobStore};
use serde_json::json;
use std::{sync::atomic::Ordering, time::Duration};

async fn advance_to(deadline: tokio::time::Instant) {
    let remaining = deadline
        .checked_duration_since(tokio::time::Instant::now())
        .unwrap();
    tokio::time::advance(remaining).await;
    assert_eq!(
        tokio::time::Instant::now(),
        deadline,
        "先达到数学上的原截止点"
    );
    // 仅唤醒 Tokio 毫秒刻度；不延长 context、业务预算或真实 watchdog。
    tokio::time::advance(Duration::from_millis(1)).await;
    assert_eq!(
        tokio::time::Instant::now(),
        deadline + Duration::from_millis(1)
    );
}

#[tokio::test(start_paused = true)]
async fn worker_queue_spends_original_budget_and_keeps_old_directory_until_start() {
    let provider = Provider::new("worker_budget", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 1, true).await;
    let old = fixture.refresh(&provider).await;
    let blocker = Invocation::blocked(json!(true));
    provider.push_for(provider.blocking_operation(), blocker.clone());
    let blocking_job = guarded(
        "占用通用工作槽",
        fixture
            .app
            .submit_async(provider.blocking_operation(), json!({})),
    )
    .await
    .unwrap();
    until("阻塞任务已经 poll", || {
        provider
            .calls()
            .iter()
            .any(|call| call.operation == provider.blocking_operation())
            .then_some(())
    })
    .await;
    let waiting = Invocation::blocked(observed(Some("sideload")));
    provider.push(waiting.clone());
    let admitted = tokio::time::Instant::now();
    let job = fixture.submit(&provider, true, json!({})).await;
    tokio::time::advance(Duration::from_secs(20)).await;
    same_json(&fixture.directory(&provider).unwrap(), &old);
    assert_eq!(provider.discovery_calls(), 1);
    blocker.finish();
    until("排队发现取得工作槽", || {
        (provider.discovery_calls() == 2).then_some(())
    })
    .await;
    let call = provider.calls().last().unwrap().clone();
    assert_eq!(call.operation, provider.operation());
    assert_eq!(call.deadline, Some(admitted + Duration::from_secs(30)));
    assert_eq!(call.started_at - admitted, Duration::from_secs(20));
    assert_eq!(
        call.deadline.unwrap() - call.started_at,
        Duration::from_secs(10)
    );
    assert!(fixture.directory(&provider).is_none());
    assert_eq!(fixture.store.get(&job.id).unwrap().operation, ALIAS);
    advance_to(call.deadline.unwrap()).await;
    until("原截止点取消执行器", || {
        waiting
            .cancellation_seen
            .load(Ordering::SeqCst)
            .then_some(())
    })
    .await;
    waiting.finish_cleanup();
    let failed = fixture.wait_terminal(&job.id).await;
    assert_eq!(failed.status, JobStatus::Failed);
    assert!(failed.error.as_deref().unwrap().contains("执行超时"));
    success(&fixture.wait_terminal(&blocking_job.id).await);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn expiry_before_worker_start_has_zero_new_calls_and_preserves_old_directory() {
    let provider = Provider::new("expired_queue", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 1, true).await;
    let old = fixture.refresh(&provider).await;
    let blocker = Invocation::blocked(json!(true));
    provider.push_for(provider.blocking_operation(), blocker.clone());
    let blocking_job = guarded(
        "占用工作槽",
        fixture
            .app
            .submit_async(provider.blocking_operation(), json!({})),
    )
    .await
    .unwrap();
    until("工作槽占用已开始", || {
        provider
            .calls()
            .iter()
            .any(|call| call.operation == provider.blocking_operation())
            .then_some(())
    })
    .await;
    let admitted = tokio::time::Instant::now();
    let job = fixture.submit(&provider, false, json!({})).await;
    advance_to(admitted + Duration::from_secs(30)).await;
    let failed = fixture.wait_terminal(&job.id).await;
    assert_eq!(failed.status, JobStatus::Failed);
    assert!(failed.error.as_deref().unwrap().contains("执行超时"));
    assert_eq!(
        provider.discovery_calls(),
        1,
        "门禁前过期没有新增执行器 poll"
    );
    same_json(&fixture.directory(&provider).unwrap(), &old);
    blocker.finish();
    success(&fixture.wait_terminal(&blocking_job.id).await);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn running_storage_wait_is_charged_before_start_gate_and_cannot_clear_on_expiry() {
    let provider = Provider::new("running_storage", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let old = fixture.refresh(&provider).await;
    let gate = fixture.store.hold(ALIAS, Phase::Running);
    let admitted = tokio::time::Instant::now();
    let job = fixture.submit(&provider, true, json!({})).await;
    until("Running 持久化尚未返回", || gate.reached()).await;
    advance_to(admitted + Duration::from_secs(30)).await;
    assert_eq!(provider.discovery_calls(), 1);
    same_json(&fixture.directory(&provider).unwrap(), &old);
    gate.release();
    let failed = fixture.wait_terminal(&job.id).await;
    assert_eq!(failed.status, JobStatus::Failed);
    assert!(failed.error.as_deref().unwrap().contains("执行超时"));
    assert_eq!(provider.discovery_calls(), 1);
    same_json(&fixture.directory(&provider).unwrap(), &old);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn same_provider_wait_spends_budget_while_prior_success_storage_remains_pending() {
    let provider = Provider::new("serial_budget", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let gate = fixture
        .store
        .hold(&provider.operation(), Phase::AfterSuccess);
    let a = fixture.submit(&provider, false, json!({})).await;
    until("A 存储返回暂停", || gate.reached()).await;
    let admitted = tokio::time::Instant::now();
    let b_control = Invocation::blocked(observed(Some("bootloader")));
    provider.push(b_control.clone());
    let b = fixture.submit(&provider, true, json!({})).await;
    tokio::time::advance(Duration::from_secs(20)).await;
    turns().await;
    assert_eq!(provider.discovery_calls(), 1);
    gate.release();
    until("B 在串行等待后真正 poll", || {
        (provider.discovery_calls() == 2).then_some(())
    })
    .await;
    let call = provider.calls().last().unwrap().clone();
    assert_eq!(call.deadline, Some(admitted + Duration::from_secs(30)));
    assert_eq!(call.started_at - admitted, Duration::from_secs(20));
    assert_eq!(
        call.deadline.unwrap() - call.started_at,
        Duration::from_secs(10)
    );
    b_control.finish();
    fixture.wait_directory(&provider, &b.id).await;
    success(&fixture.store.get(&a.id).unwrap());
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn deadline_after_succeeded_retains_history_but_returns_timeout_not_acceptance() {
    let provider = Provider::new("after_success_deadline", 3, true);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let gate = fixture
        .store
        .hold(&provider.operation(), Phase::AfterSuccess);
    let admitted = tokio::time::Instant::now();
    let devices = fixture.devices.clone();
    let request = fixture.identity(&provider);
    let refresh = tokio::spawn(async move { devices.refresh(request).await });
    let id = until("已成功但未发布", || gate.reached()).await;
    let history = fixture.store.get(&id).unwrap();
    let events = fixture.store.events(&id, 0).unwrap();
    success(&history);
    let call = provider.calls().last().unwrap().clone();
    assert_eq!(call.deadline, Some(admitted + Duration::from_secs(30)));
    advance_to(call.deadline.unwrap()).await;
    gate.release();
    assert_eq!(
        code(guarded("过期发布回执", refresh).await.unwrap()),
        "timeout"
    );
    assert!(fixture.directory(&provider).is_none());
    same_json(&fixture.store.get(&id).unwrap(), &history);
    same_json(&fixture.store.events(&id, 0).unwrap(), &events);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn create_storage_wait_counts_toward_deadline_without_crossing_start_gate() {
    let provider = Provider::new("create_storage", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let old = fixture.refresh(&provider).await;
    let gate = fixture.store.hold(ALIAS, Phase::Create);
    let app = fixture.app.clone();
    let admitted = tokio::time::Instant::now();
    let submit = tokio::spawn(async move { app.submit_async(ALIAS.into(), json!({})).await });
    let id = until("创建存储尚未完成", || gate.reached()).await;
    assert_eq!(fixture.store.jobs().len(), 1);
    advance_to(admitted + Duration::from_secs(30)).await;
    assert_eq!(provider.discovery_calls(), 1);
    same_json(&fixture.directory(&provider).unwrap(), &old);
    gate.release();
    // 创建可能在不可撤销的阻塞操作中完成；断言零执行，不假装一定零新 Job。
    assert_eq!(
        code(guarded("过期创建操作收敛", submit).await.unwrap()),
        "timeout"
    );
    // 阻塞 create 实际完成后形成的历史仍须收敛，不能把它冒充调用方成功。
    fixture.wait_terminal(&id).await;
    assert_eq!(fixture.store.jobs().len(), 2);
    assert_eq!(provider.discovery_calls(), 1);
    same_json(&fixture.directory(&provider).unwrap(), &old);
    fixture.shutdown().await;
}
