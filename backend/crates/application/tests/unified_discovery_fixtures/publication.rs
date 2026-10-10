//! 成功观测终态与有条件接受目录用例。
use crate::fixtures::executor::{Invocation, Provider, observed};
use crate::fixtures::store::Phase;
use crate::fixtures::{Fixture, code, guarded, same_json, success, until};
use apk_domain::{JobStatus, JobStore};
use serde_json::json;
use std::{future::Future, task::Poll};

#[tokio::test(start_paused = true)]
async fn cancellation_after_success_claim_waits_for_history_but_rejects_candidate() {
    let provider = Provider::new("before_success", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let gate = fixture
        .store
        .hold(&provider.operation(), Phase::BeforeSuccess);
    let devices = fixture.devices.clone();
    let request = fixture.identity(&provider);
    let refresh = tokio::spawn(async move { devices.refresh(request).await });
    let id = until("成功资格已取得且存储事务已进入", || {
        gate.reached()
    })
    .await;
    assert_eq!(fixture.store.get(&id).unwrap().status, JobStatus::Running);
    let cancelling = fixture.app.cancel_async(id.clone());
    tokio::pin!(cancelling);
    // 首次 poll 已同步拒绝目录候选，但取消返回须等待已取得资格的存储事务。
    std::future::poll_fn(|context| {
        assert!(cancelling.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(fixture.store.get(&id).unwrap().status, JobStatus::Running);
    gate.release();
    let cancelled = guarded("成功事务排空后取消返回实际历史", cancelling)
        .await
        .unwrap();
    success(&cancelled);
    assert_eq!(
        code(guarded("取得资格后的发现取消回执", refresh).await.unwrap()),
        "cancelled"
    );
    assert!(fixture.app.operation(&provider.operation()).is_some());
    assert!(
        fixture.directory(&provider).is_none(),
        "卸载之前就必须拒绝候选"
    );
    // 回执明确拒绝且提供者仍加载，随后卸载不能掩盖取消发布失效。
    guarded(
        "等待取消候选彻底收敛",
        fixture.plugins.unload(provider.id.clone()),
    )
    .await
    .unwrap();
    assert!(fixture.directory(&provider).is_none());
    success(&fixture.store.get(&id).unwrap());
    assert_eq!(
        fixture
            .store
            .events(&id, 0)
            .unwrap()
            .iter()
            .filter(|event| event.status.is_terminal())
            .map(|event| event.status.clone())
            .collect::<Vec<_>>(),
        vec![JobStatus::Succeeded]
    );
    assert_eq!(provider.discovery_calls(), 1);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_before_success_claim_preserves_cancelled_history_and_rejects_candidate() {
    let provider = Provider::new("before_claim", 3, false);
    let control = Invocation::blocked(observed(Some("recovery")));
    provider.push(control.clone());
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let job = fixture.submit(&provider, true, json!({})).await;
    until("发现执行器已开始且尚未返回候选", || {
        (provider.discovery_calls() == 1).then_some(())
    })
    .await;
    let cancelled = guarded("成功资格前取消", fixture.app.cancel_async(job.id.clone()))
        .await
        .unwrap();
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    control.finish_cleanup();
    guarded(
        "等待资格前取消候选收敛",
        fixture.plugins.unload(provider.id.clone()),
    )
    .await
    .unwrap();
    assert!(fixture.directory(&provider).is_none());
    assert_eq!(
        fixture.store.get(&job.id).unwrap().status,
        JobStatus::Cancelled
    );
    assert!(
        fixture
            .store
            .events(&job.id, 0)
            .unwrap()
            .iter()
            .all(|event| { event.status != JobStatus::Succeeded })
    );
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn succeeded_job_cancellation_still_rejects_pending_refresh_publication() {
    let provider = Provider::new("succeeded_cancel", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let gate = fixture
        .store
        .hold(&provider.operation(), Phase::AfterSuccess);
    let devices = fixture.devices.clone();
    let request = fixture.identity(&provider);
    let refresh = tokio::spawn(async move { devices.refresh(request).await });
    let id = until("Succeeded 之后但 transition 未返回", || {
        gate.reached()
    })
    .await;
    let history = fixture.store.get(&id).unwrap();
    success(&history);
    let events = fixture.store.events(&id, 0).unwrap();
    let cancelled = guarded(
        "终态不能跳过 Pending 门禁",
        fixture.app.cancel_async(id.clone()),
    )
    .await
    .unwrap();
    success(&cancelled);
    gate.release();
    assert_eq!(
        code(guarded("本次 refresh 取消回执", refresh).await.unwrap()),
        "cancelled"
    );
    assert!(fixture.directory(&provider).is_none());
    same_json(&fixture.store.get(&id).unwrap(), &history);
    same_json(&fixture.store.events(&id, 0).unwrap(), &events);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn acceptance_before_cancel_keeps_directory_and_success_events() {
    let provider = Provider::new("accepted", 3, true);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let directory = fixture.refresh(&provider).await;
    let history = fixture.store.get(&directory.discovery_job_id).unwrap();
    let events = fixture.store.events(&history.id, 0).unwrap();
    success(
        &guarded(
            "已接受后的用户取消",
            fixture.app.cancel_async(history.id.clone()),
        )
        .await
        .unwrap(),
    );
    same_json(&fixture.directory(&provider).unwrap(), &directory);
    same_json(&fixture.store.get(&history.id).unwrap(), &history);
    same_json(&fixture.store.events(&history.id, 0).unwrap(), &events);
    assert_eq!(provider.discovery_calls(), 1);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn actual_cancelled_transition_and_storage_failure_cannot_publish_success() {
    for storage_failure in [false, true] {
        let provider = Provider::new("actual_transition", 3, false);
        let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
        if storage_failure {
            fixture.store.fail_next_success();
        } else {
            fixture.store.return_cancelled_for_success();
        }
        let result = guarded(
            "检查 transition 实际返回值",
            fixture.devices.refresh(fixture.identity(&provider)),
        )
        .await;
        assert_eq!(
            code(result),
            if storage_failure {
                "storage_failed"
            } else {
                "cancelled"
            }
        );
        assert!(fixture.directory(&provider).is_none());
        assert_eq!(fixture.store.jobs().len(), 1);
        assert_eq!(provider.discovery_calls(), 1);
        assert_ne!(fixture.store.jobs()[0].status, JobStatus::Succeeded);
        // 失败不泄漏发现额度，后一轮独立成功能创建并接受自己的 Job。
        fixture.refresh(&provider).await;
        assert_eq!(fixture.store.jobs().len(), 2);
        fixture.shutdown().await;
    }
}

#[tokio::test(start_paused = true)]
async fn old_array_missing_raw_rejects_whole_observation_but_empty_array_succeeds() {
    let provider = Provider::new("complete_raw", 3, true);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    for value in [
        observed(None),
        json!([{
            "id":"same", "state":"unknown", "raw_state":null, "model":null, "capabilities":[],
        }]),
        json!([
            {"id":"good","state":"unknown","raw_state":"recovery","model":null,"capabilities":[]},
            {"id":"bad","state":"unknown","model":null,"capabilities":[]},
        ]),
    ] {
        fixture.refresh(&provider).await;
        provider.push(Invocation::ready(value));
        let job = fixture.submit(&provider, true, json!({})).await;
        let failed = fixture.wait_terminal(&job.id).await;
        assert_eq!(failed.status, JobStatus::Failed);
        assert!(failed.result.is_none());
        assert!(failed.error.is_some());
        assert!(fixture.directory(&provider).is_none());
    }
    provider.push(Invocation::ready(json!([])));
    let empty = fixture.submit(&provider, true, json!({})).await;
    let directory = fixture.wait_directory(&provider, &empty.id).await;
    assert!(directory.devices.is_empty());
    assert_eq!(
        fixture.store.get(&empty.id).unwrap().result,
        Some(json!([]))
    );
    provider.push(Invocation::ready(observed(None)));
    let no_raw = fixture.submit(&provider, false, json!({})).await;
    let directory = fixture.wait_directory(&provider, &no_raw.id).await;
    assert!(
        serde_json::to_value(directory).unwrap()["devices"][0]
            .get("raw_state")
            .is_none()
    );
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn plain_json_fake_host_wrapper_and_mixed_bad_device_are_not_accepted() {
    let provider = Provider::new("strict_observation", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    for value in [
        json!({"result":observed(Some("recovery")),"artifacts":[]}),
        json!([
            {"id":"good","state":"unknown","raw_state":"bootloader","model":null,"capabilities":[]},
            {"id":"bad","state":"unknown","raw_state":"","model":null,"capabilities":[]},
        ]),
    ] {
        fixture.refresh(&provider).await;
        provider.push(Invocation::ready(value));
        assert_eq!(
            code(
                guarded(
                    "拒绝伪包装或半份观测",
                    fixture.devices.refresh(fixture.identity(&provider))
                )
                .await
            ),
            "dependency_failed"
        );
        assert!(fixture.directory(&provider).is_none());
        assert_eq!(
            fixture.store.jobs().last().unwrap().status,
            JobStatus::Failed
        );
        assert!(fixture.store.jobs().last().unwrap().result.is_none());
    }
    fixture.shutdown().await;
}
