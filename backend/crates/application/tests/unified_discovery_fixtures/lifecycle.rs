//! 撤销、重载、历史与未确认清理用例。
use crate::fixtures::executor::{Invocation, Provider, observed};
use crate::fixtures::store::Phase;
use crate::fixtures::{ALIAS, Fixture, code, guarded, same_json, success, turns, until};
use apk_domain::{JobStatus, JobStore, devices::DeviceActionRequest, plugins::PluginState};
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test(start_paused = true)]
async fn unload_after_succeeded_rejects_pending_refresh_and_preserves_success_history() {
    let provider = Provider::new("pending_unload", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let gate = fixture
        .store
        .hold(&provider.operation(), Phase::AfterSuccess);
    let devices = fixture.devices.clone();
    let request = fixture.identity(&provider);
    let refresh = tokio::spawn(async move { devices.refresh(request).await });
    let id = until("成功存储之后", || gate.reached()).await;
    let history = fixture.store.get(&id).unwrap();
    let events = fixture.store.events(&id, 0).unwrap();
    success(&history);
    let plugins = fixture.plugins.clone();
    let owner = provider.id.clone();
    let unload = tokio::spawn(async move { plugins.unload(owner).await });
    until("卸载已撤销真实入口", || {
        fixture
            .app
            .operation(&provider.operation())
            .is_none()
            .then_some(())
    })
    .await;
    assert!(fixture.app.operation(ALIAS).is_none());
    assert!(fixture.devices.providers().is_empty());
    gate.release();
    assert_eq!(
        code(guarded("卸载先赢的 refresh 回执", refresh).await.unwrap()),
        "conflict"
    );
    assert_eq!(
        guarded("卸载收敛", unload).await.unwrap().unwrap().state,
        PluginState::Unloaded
    );
    same_json(&fixture.store.get(&id).unwrap(), &history);
    same_json(&fixture.store.events(&id, 0).unwrap(), &events);
    assert!(fixture.devices.directories().is_empty());
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn unload_reload_rejects_old_generation_and_never_rewrites_raw_history() {
    let provider = Provider::new("history", 3, true);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    provider.push(Invocation::ready(observed(Some(" FutureMode 中文 "))));
    let job = fixture.submit(&provider, true, json!({})).await;
    let directory = fixture.wait_directory(&provider, &job.id).await;
    let history = fixture.store.get(&job.id).unwrap();
    let events = fixture.store.events(&job.id, 0).unwrap();
    let old = fixture.identity(&provider);
    guarded(
        "正常卸载发现贡献",
        fixture.plugins.unload(provider.id.clone()),
    )
    .await
    .unwrap();
    assert!(fixture.app.operation(ALIAS).is_none());
    assert!(fixture.devices.directories().is_empty());
    assert_eq!(
        code(
            guarded(
                "缺目标别名不回退",
                fixture.app.submit_async(ALIAS.into(), json!({}))
            )
            .await
        ),
        "not_found"
    );
    let next = guarded("重载提供者", fixture.plugins.load(provider.id.clone()))
        .await
        .unwrap();
    assert_ne!(next.generation, old.generation);
    let count = fixture.store.jobs().len();
    assert_eq!(
        code(guarded("旧代发现精确拒绝", fixture.devices.refresh(old)).await),
        "conflict"
    );
    assert_eq!(fixture.store.jobs().len(), count);
    assert!(fixture.devices.directories().is_empty());
    let next_directory = fixture.refresh(&provider).await;
    assert_ne!(next_directory.discovery_job_id, directory.discovery_job_id);
    assert_eq!(next_directory.provider.generation, next.generation);
    same_json(&fixture.store.get(&history.id).unwrap(), &history);
    same_json(&fixture.store.events(&history.id, 0).unwrap(), &events);
    assert_eq!(history.result.unwrap()[0]["state"], " FutureMode 中文 ");
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn unresolved_cleanup_blocks_new_and_serial_waiting_discovery_then_reload() {
    let provider = Provider::new("unresolved", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let first = Invocation::blocked(observed(Some("recovery")));
    first.fail_cleanup.store(true, Ordering::SeqCst);
    provider.push(first.clone());
    let a = fixture.submit(&provider, false, json!({})).await;
    until("A 已开始执行", || {
        (provider.discovery_calls() == 1).then_some(())
    })
    .await;
    let b = fixture.submit(&provider, true, json!({})).await;
    guarded("取消未确认资源任务", fixture.app.cancel_async(a.id.clone()))
        .await
        .unwrap();
    until("开始有界清理", || {
        first.cancellation_seen.load(Ordering::SeqCst).then_some(())
    })
    .await;
    assert_eq!(provider.discovery_calls(), 1);
    first.finish_cleanup();
    let failed = fixture.wait_terminal(&b.id).await;
    assert_eq!(failed.status, JobStatus::Failed);
    assert!(failed.error.unwrap().contains("清理未确认"));
    assert_eq!(
        provider.discovery_calls(),
        1,
        "排队目标不可越过 cleanup_failed"
    );
    until("owner 资源标记可见", || {
        fixture
            .plugins
            .list()
            .iter()
            .any(|plugin| plugin.cleanup_failed)
            .then_some(())
    })
    .await;
    assert_eq!(
        code(
            guarded(
                "未确认 owner 拒绝新别名",
                fixture.app.submit_async(ALIAS.into(), json!({}))
            )
            .await
        ),
        "conflict"
    );
    assert_eq!(
        code(
            guarded(
                "资源未确认的卸载",
                fixture.plugins.unload(provider.id.clone())
            )
            .await
        ),
        "cleanup_failed"
    );
    let owner = fixture
        .plugins
        .list()
        .into_iter()
        .find(|plugin| plugin.id == provider.id)
        .unwrap();
    assert_eq!(owner.state, PluginState::Draining);
    assert!(owner.cleanup_failed);
    assert_eq!(
        code(
            guarded(
                "未确认 owner 拒绝重载",
                fixture.plugins.load(provider.id.clone())
            )
            .await
        ),
        "conflict"
    );
    assert!(fixture.devices.directories().is_empty());
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn dropped_refresh_retains_both_permits_until_confirmed_cleanup() {
    let provider = Provider::new("dropped", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let first = Invocation::blocked(observed(Some("recovery")));
    provider.push(first.clone());
    let devices = fixture.devices.clone();
    let request = fixture.identity(&provider);
    let refresh = tokio::spawn(async move { devices.refresh(request).await });
    until("refresh 业务已 poll", || {
        (provider.discovery_calls() == 1).then_some(())
    })
    .await;
    let b = fixture.submit(&provider, false, json!({})).await;
    refresh.abort();
    assert!(
        guarded("撤销外部等待者", refresh)
            .await
            .unwrap_err()
            .is_cancelled()
    );
    until("原任务收到取消", || {
        first.cancellation_seen.load(Ordering::SeqCst).then_some(())
    })
    .await;
    let count = fixture.store.jobs().len();
    assert_eq!(
        code(
            guarded(
                "Future 丢弃不能释放额度",
                fixture.app.submit_async(ALIAS.into(), json!({}))
            )
            .await
        ),
        "conflict"
    );
    assert_eq!(fixture.store.jobs().len(), count);
    assert_eq!(provider.discovery_calls(), 1);
    first.finish_cleanup();
    fixture.wait_directory(&provider, &b.id).await;
    assert!(first.cleaned.load(Ordering::SeqCst));
    let b_directory = fixture.directory(&provider).unwrap();
    turns().await;
    same_json(&fixture.directory(&provider).unwrap(), &b_directory);
    assert_eq!(
        provider.discovery_calls(),
        2,
        "旧等待者释放不重复执行或清新目录"
    );
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn restart_retains_raw_events_but_does_not_restore_actionable_directory() {
    let provider = Provider::new("restart", 3, false);
    let first = Fixture::new(vec![provider.clone()], 2, true).await;
    provider.push(Invocation::ready(observed(Some("bootloader"))));
    let directory = first.refresh(&provider).await;
    let history = first.store.get(&directory.discovery_job_id).unwrap();
    let events = first.store.events(&history.id, 0).unwrap();
    let old = first.identity(&provider);
    first.shutdown().await;
    let next = Fixture::with_store(vec![provider.clone()], 2, true, first.store.clone()).await;
    assert!(next.devices.directories().is_empty());
    same_json(&next.store.get(&history.id).unwrap(), &history);
    same_json(&next.store.events(&history.id, 0).unwrap(), &events);
    assert_eq!(
        code(guarded("重启后旧代拒绝", next.devices.refresh(old)).await),
        "conflict"
    );
    let current = next.identity(&provider);
    let action = DeviceActionRequest {
        provider_id: current.id.clone(),
        generation: current.generation.clone(),
        device_id: Some("same".into()),
        capability: "inspect".into(),
        version: 1,
        input: json!({}),
    };
    assert_eq!(
        code(guarded("历史不恢复动作观测", next.devices.invoke(action)).await),
        "conflict"
    );
    let refreshed = next.refresh(&provider).await;
    assert_ne!(refreshed.discovery_job_id, history.id);
    assert_eq!(refreshed.provider.generation, current.generation);
    next.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn shutdown_closes_admission_before_waiting_for_pending_cleanup() {
    let provider = Provider::new("shutdown", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let pending = Invocation::blocked(observed(Some("recovery")));
    provider.push(pending.clone());
    fixture.submit(&provider, false, json!({})).await;
    until("停止前执行器已开始", || {
        (provider.discovery_calls() == 1).then_some(())
    })
    .await;
    let app = fixture.app.clone();
    let shutdown = tokio::spawn(async move { app.shutdown().await });
    until("shutdown 已关闭准入并取消执行", || {
        pending
            .cancellation_seen
            .load(Ordering::SeqCst)
            .then_some(())
    })
    .await;
    let count = fixture.store.jobs().len();
    assert_eq!(
        code(
            guarded(
                "停止期不能新建发现 Job",
                fixture.app.submit_async(ALIAS.into(), json!({}))
            )
            .await
        ),
        "conflict"
    );
    assert_eq!(
        code(
            guarded(
                "停止期 refresh 拒绝",
                fixture.devices.refresh(fixture.identity(&provider))
            )
            .await
        ),
        "conflict"
    );
    assert_eq!(fixture.store.jobs().len(), count);
    assert_eq!(provider.discovery_calls(), 1);
    assert!(!shutdown.is_finished());
    pending.finish_cleanup();
    guarded("shutdown 等清理完成", shutdown)
        .await
        .unwrap()
        .unwrap();
    assert!(pending.cleaned.load(Ordering::SeqCst));
    fixture.shutdown().await;
}
