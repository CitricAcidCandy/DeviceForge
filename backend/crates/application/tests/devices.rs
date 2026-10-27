#[path = "devices/support.rs"]
mod support;
use apk_domain::{Error, JobStatus};
use serde_json::json;
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use support::*;

async fn started(provider: &Provider) {
    tokio::time::timeout(Duration::from_secs(2), provider.started.notified())
        .await
        .unwrap();
}
async fn settled(app: &Arc<apk_application::Application>, id: String) -> JobStatus {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let job = app.get_async(id.clone()).await.unwrap();
            if job.status.is_terminal() {
                return job.status;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn discovery_boundaries_identity_generation_and_exact_capability() {
    let provider = Provider::new("first");
    let (app, plugins, devices, input) = setup(provider.clone()).await;
    assert!(matches!(
        devices.invoke(action(&input, "write", Some("same"))).await,
        Err(Error::Conflict(_))
    ));
    let directory = devices.refresh(input.clone()).await.unwrap();
    assert_eq!(directory.devices[0].reference.provider_id, "first");
    assert_eq!(directory.devices[0].reference.generation, input.generation);
    assert!(directory.observed_at > 0);
    let mut request = action(&input, "write", Some("same"));
    request.version = 2;
    assert!(matches!(
        devices.invoke(request).await,
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        devices
            .invoke(action(&input, "write", Some("missing")))
            .await,
        Err(Error::NotFound(_))
    ));
    let mut request = action(&input, "write", Some("same"));
    request.input = json!(null);
    assert!(matches!(
        devices.invoke(request).await,
        Err(Error::Invalid(_))
    ));
    for value in [
        json!([{"id":"same","state":"invalid","capabilities":[]}]),
        json!([{"id":"same","state":"online","capabilities":[]},{"id":"same","state":"online","capabilities":[]}]),
        json!([{"id":"same","state":"online","capabilities":[{"id":"undeclared","version":1,"available":true}]}]),
        json!({"result":[]}),
    ] {
        *provider.discovery.lock().unwrap() = value;
        assert!(matches!(
            devices.refresh(input.clone()).await,
            Err(Error::Dependency(_))
        ));
        assert!(devices.directories().is_empty());
    }
    *provider.discovery.lock().unwrap() = json!([{"id":"same","state":"online","capabilities":[]}]);
    devices.refresh(input.clone()).await.unwrap();
    assert!(matches!(
        devices.invoke(action(&input, "read", Some("same"))).await,
        Err(Error::Conflict(_))
    ));
    *provider.discovery.lock().unwrap() = json!({"result":observed(),"artifacts":[]});
    assert!(matches!(
        devices.refresh(input.clone()).await,
        Err(Error::Dependency(_))
    ));
    provider.published.store(true, Ordering::SeqCst);
    devices.refresh(input.clone()).await.unwrap();
    plugins.unload(input.id.clone()).await.unwrap();
    assert!(devices.directories().is_empty());
    let next = plugins.load(input.id.clone()).await.unwrap();
    assert_ne!(next.generation, input.generation);
    assert!(matches!(
        devices.refresh(input).await,
        Err(Error::Conflict(_))
    ));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn required_business_fields_and_device_enum_register_but_validate_actual_submission() {
    let provider = Provider::new("business");
    *provider.schema.lock().unwrap() = Some(json!({"type":"object","properties":{
        "device_id":{"type":"string","enum":["same"],"pattern":"^same$"},
        "input":{"type":"object","properties":{"artifact_id":{"type":"string"}},"required":["artifact_id"],"additionalProperties":false}
    },"required":["device_id","input"],"additionalProperties":false}));
    let (app, _, devices, input) = setup(provider).await;
    devices.refresh(input.clone()).await.unwrap();
    assert!(matches!(
        devices.invoke(action(&input, "write", Some("same"))).await,
        Err(Error::Invalid(_))
    ));
    let mut request = action(&input, "write", Some("same"));
    request.input = json!({"artifact_id":"stored-artifact"});
    let job = devices.invoke(request).await.unwrap();
    assert_eq!(settled(&app, job.id).await, JobStatus::Succeeded);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn refresh_inherits_request_context_and_shutdown_closes_admission() {
    let provider = Provider::new("logging");
    let (app, _, devices, input) = setup(provider.clone()).await;
    let context = deviceforge_observability::LogContext::default();
    context.scope(devices.refresh(input.clone())).await.unwrap();
    assert_eq!(&*provider.logs.lock().unwrap(), &[context.log_id]);
    app.shutdown().await.unwrap();
    assert!(matches!(
        devices.refresh(input).await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dropped_refresh_keeps_capacity_until_cancel_cleanup_and_unload_removes_directory() {
    let provider = Provider::new("cancel");
    let (app, plugins, devices, input) = setup(provider.clone()).await;
    devices.refresh(input.clone()).await.unwrap();
    started(&provider).await;
    provider.blocked.store(true, Ordering::SeqCst);
    let first = {
        let devices = devices.clone();
        let input = input.clone();
        tokio::spawn(async move { devices.refresh(input).await })
    };
    started(&provider).await;
    let second = {
        let devices = devices.clone();
        let input = input.clone();
        tokio::spawn(async move { devices.refresh(input).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(matches!(
        devices.refresh(input.clone()).await,
        Err(Error::Conflict(_))
    ));
    first.abort();
    let _ = first.await;
    assert!(matches!(
        devices.refresh(input.clone()).await,
        Err(Error::Conflict(_))
    ));
    started(&provider).await;
    assert_eq!(provider.cleaned.load(Ordering::SeqCst), 1);
    plugins.unload(input.id).await.unwrap();
    assert!(matches!(second.await.unwrap(), Err(Error::Conflict(_))));
    assert_eq!(provider.cleaned.load(Ordering::SeqCst), 2);
    assert!(devices.directories().is_empty());
    app.shutdown().await.unwrap();
    assert!(
        app.list_async(10)
            .await
            .unwrap()
            .iter()
            .all(|job| job.status.is_terminal())
    );
}

#[tokio::test]
async fn provider_barrier_covers_direct_jobs_and_cancelled_lock_waiters_do_not_execute() {
    let provider = Provider::new("locks");
    let (app, _, devices, input) = setup(provider.clone()).await;
    devices.refresh(input.clone()).await.unwrap();
    started(&provider).await;
    provider.blocked.store(true, Ordering::SeqCst);
    let global = devices
        .invoke(action(&input, "global", None))
        .await
        .unwrap();
    started(&provider).await;
    let read = app
        .submit_async(
            "plugin.locks.read".into(),
            json!({"device_id":"same","input":{}}),
        )
        .await
        .unwrap();
    let write = devices
        .invoke(action(&input, "write", Some("same")))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(30), provider.started.notified())
            .await
            .is_err()
    );
    app.cancel_async(write.id.clone()).await.unwrap();
    provider.release.add_permits(1);
    assert_eq!(settled(&app, global.id).await, JobStatus::Succeeded);
    started(&provider).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    assert_eq!(settled(&app, write.id).await, JobStatus::Cancelled);
    assert!(matches!(
        app.submit_async(
            "plugin.locks.write".into(),
            json!({"input":{},"write":false})
        )
        .await,
        Err(Error::Invalid(_))
    ));
    provider.release.add_permits(1);
    assert_eq!(settled(&app, read.id).await, JobStatus::Succeeded);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn device_writes_serialize_but_other_devices_and_same_device_reads_run_concurrently() {
    let provider = Provider::new("parallel");
    let (app, _, devices, input) = setup(provider.clone()).await;
    devices.refresh(input.clone()).await.unwrap();
    started(&provider).await;
    provider.blocked.store(true, Ordering::SeqCst);
    let a = devices
        .invoke(action(&input, "write", Some("same")))
        .await
        .unwrap();
    started(&provider).await;
    let b = devices
        .invoke(action(&input, "write", Some("same")))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(30), provider.started.notified())
            .await
            .is_err()
    );
    let c = devices
        .invoke(action(&input, "write", Some("other")))
        .await
        .unwrap();
    started(&provider).await;
    let d = devices
        .invoke(action(&input, "read", Some("same")))
        .await
        .unwrap();
    started(&provider).await;
    app.cancel_async(b.id.clone()).await.unwrap();
    assert_eq!(settled(&app, b.id).await, JobStatus::Cancelled);
    provider.release.add_permits(3);
    for job in [a, c, d] {
        assert_eq!(settled(&app, job.id).await, JobStatus::Succeeded);
    }
    assert_eq!(provider.calls.load(Ordering::SeqCst), 4);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn historical_cleanup_risk_stays_visible_while_queued_and_new_jobs_execute() {
    for failed in [false, true] {
        let provider = Provider::new("cleanup");
        let (app, plugins, devices, input) = setup(provider.clone()).await;
        devices.refresh(input.clone()).await.unwrap();
        started(&provider).await;
        provider.blocked.store(true, Ordering::SeqCst);
        provider.fail_cleanup.store(failed, Ordering::SeqCst);
        let first = devices
            .invoke(action(&input, "write", Some("same")))
            .await
            .unwrap();
        started(&provider).await;
        let queued = app
            .submit_async(
                "plugin.cleanup.write".into(),
                json!({"device_id":"same","input":{}}),
            )
            .await
            .unwrap();
        assert_eq!(
            app.get_async(queued.id.clone()).await.unwrap().status,
            JobStatus::Queued
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        let cancelled = app.cancel_async(first.id.clone()).await.unwrap();
        assert_eq!(cancelled.status, JobStatus::Cancelled);

        for (index, entry) in ["queued", "device", "direct"].into_iter().enumerate() {
            let job = match entry {
                "queued" => queued.clone(),
                "device" => devices
                    .invoke(action(&input, "write", Some("same")))
                    .await
                    .expect("历史清理告警不得阻止新的设备调用"),
                _ => app
                    .submit_async(
                        "plugin.cleanup.write".into(),
                        json!({"device_id":"same","input":{}}),
                    )
                    .await
                    .expect("历史清理告警不得阻止新的直接任务"),
            };
            started(&provider).await;
            assert_eq!(provider.calls.load(Ordering::SeqCst), index + 3);
            assert_eq!(provider.cleaned.load(Ordering::SeqCst), 1);
            assert_eq!(provider.unresolved.load(Ordering::SeqCst), failed);
            let plugin = &plugins.list()[0];
            assert_eq!(plugin.generation, input.generation);
            assert_eq!(plugin.cleanup_failed, failed);

            // 每笔调用仍经过真实设备互斥并等待自身许可，旧告警不代替活动锁。
            assert_eq!(
                app.get_async(job.id.clone()).await.unwrap().status,
                JobStatus::Running
            );
            provider.release.add_permits(1);
            assert_eq!(settled(&app, job.id.clone()).await, JobStatus::Succeeded);
            let completed = app.get_async(job.id).await.unwrap();
            assert_eq!(completed.result, Some(completed.input));
            assert!(completed.error.is_none());
            assert_eq!(provider.release.available_permits(), 0);

            // 新成功不清除历史风险，也不能改写旧任务已经取得的取消终态。
            assert_eq!(provider.unresolved.load(Ordering::SeqCst), failed);
            assert_eq!(plugins.list()[0].cleanup_failed, failed);
            let history = app.get_async(first.id.clone()).await.unwrap();
            assert_eq!(history.status, cancelled.status);
            assert_eq!(history.result, cancelled.result);
            assert_eq!(history.error, cancelled.error);
        }
        assert_eq!(provider.calls.load(Ordering::SeqCst), 5);
        assert_eq!(provider.cleaned.load(Ordering::SeqCst), 1);
        app.shutdown().await.unwrap();
    }
}
