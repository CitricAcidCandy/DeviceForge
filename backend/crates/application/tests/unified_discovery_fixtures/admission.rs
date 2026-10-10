//! 三入口准入与共享额度用例。
use crate::fixtures::executor::{Invocation, Provider, observed};
use crate::fixtures::store::Phase;
use crate::fixtures::{self, ALIAS, Fixture, code, guarded, same_json, success, turns, until};
use apk_domain::{JobStatus, JobStore};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

#[tokio::test(start_paused = true)]
async fn three_entries_keep_one_job_one_call_and_full_raw_observation() {
    for wrapped in [false, true] {
        let provider = Provider::new("entry", 3, wrapped);
        let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
        for entry in ["refresh", "direct", "alias"] {
            let count = fixture.store.jobs().len();
            let calls = provider.discovery_calls();
            let observation = observed(Some(" BootLoader 中文 "));
            provider.push(Invocation::ready(observation.clone()));
            let id = if entry == "refresh" {
                fixture.refresh(&provider).await.discovery_job_id
            } else {
                let job = fixture.submit(&provider, entry == "alias", json!({})).await;
                fixture.wait_directory(&provider, &job.id).await;
                job.id
            };
            let job = fixture.store.get(&id).unwrap();
            success(&job);
            assert_eq!(fixture.store.jobs().len() - count, 1);
            assert_eq!(provider.discovery_calls() - calls, 1);
            assert_eq!(job.input, json!({}));
            assert_eq!(
                job.operation,
                if entry == "alias" {
                    ALIAS.into()
                } else {
                    provider.operation()
                }
            );
            let directory = fixture.directory(&provider).unwrap();
            assert_eq!(directory.discovery_job_id, id);
            assert_eq!(
                directory.provider.generation,
                fixture.identity(&provider).generation
            );
            let serialized = serde_json::to_value(&directory).unwrap();
            assert_eq!(serialized["devices"][0]["raw_state"], " BootLoader 中文 ");
            assert_eq!(serialized["devices"][0]["reference"]["local_id"], "same");
            assert_eq!(serialized["devices"][0]["state"], "unknown");
            assert_eq!(serialized["devices"][0]["model"], Value::Null);
            if entry == "alias" {
                assert_eq!(
                    job.result,
                    Some(
                        json!([{"id":"same","platform":"android","state":" BootLoader 中文 ","model":null}])
                    )
                );
            } else {
                assert_eq!(
                    job.result,
                    Some(if wrapped {
                        json!({"result":observation,"artifacts":[]})
                    } else {
                        observation
                    })
                );
            }
            let call = provider.calls().last().unwrap().clone();
            assert_eq!(call.operation, provider.operation());
            assert_eq!(call.input, json!({}));
            assert_eq!(
                call.deadline.unwrap() - call.started_at,
                std::time::Duration::from_secs(30)
            );
            let events = fixture.store.events(&id, 0).unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.status == JobStatus::Succeeded)
                    .count(),
                1
            );
        }
        fixture.shutdown().await;
    }
}

#[tokio::test(start_paused = true)]
async fn strict_direct_and_alias_inputs_have_zero_jobs_calls_and_directory_changes() {
    let provider = Provider::new("strict", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let old = fixture.refresh(&provider).await;
    let count = fixture.store.jobs().len();
    let calls = provider.discovery_calls();
    for alias in [false, true] {
        for input in [
            json!(null),
            json!([]),
            json!(""),
            json!({"extra":1}),
            json!({"device_id":"same"}),
            json!({"generation":"fake"}),
            json!({"artifact_id":"fake"}),
        ] {
            let result = guarded(
                "坏业务输入拒绝",
                fixture.app.submit_async(
                    if alias {
                        ALIAS.into()
                    } else {
                        provider.operation()
                    },
                    input,
                ),
            )
            .await;
            assert_eq!(code(result), "invalid_input");
            assert_eq!(fixture.store.jobs().len(), count);
            assert_eq!(provider.discovery_calls(), calls);
            same_json(&fixture.directory(&provider).unwrap(), &old);
        }
    }
    let mut invalid = fixture.identity(&provider);
    invalid.generation.clear();
    assert_eq!(
        code(guarded("refresh 身份语法拒绝", fixture.devices.refresh(invalid)).await),
        "invalid_input"
    );
    let mut stale = fixture.identity(&provider);
    stale.generation = "old-generation".into();
    assert_eq!(
        code(guarded("refresh 旧代拒绝", fixture.devices.refresh(stale)).await),
        "conflict"
    );
    let unknown = apk_domain::devices::ProviderInput {
        id: "not_installed".into(),
        generation: "valid-generation".into(),
    };
    assert_eq!(
        code(guarded("refresh 未知目标拒绝", fixture.devices.refresh(unknown)).await),
        "not_found"
    );
    assert_eq!(fixture.store.jobs().len(), count);
    assert_eq!(provider.discovery_calls(), calls);
    same_json(&fixture.directory(&provider).unwrap(), &old);
    let blocked = Invocation::blocked(observed(Some("recovery")));
    provider.push(blocked.clone());
    let a = fixture.submit(&provider, false, json!({})).await;
    until("坏输入之后第一份额度可用", || {
        (provider.discovery_calls() == calls + 1).then_some(())
    })
    .await;
    let b = fixture.submit(&provider, true, json!({})).await;
    assert_eq!(
        fixture.store.jobs().len(),
        count + 2,
        "坏输入和坏目标没有泄漏两额度"
    );
    blocked.finish();
    fixture.wait_directory(&provider, &b.id).await;
    success(&fixture.store.get(&a.id).unwrap());
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn shared_two_permits_reject_third_before_job_and_survive_pending_cleanup() {
    let a = Provider::new("quota_a", 3, false);
    let b = Provider::new("quota_b", 3, false);
    let c = Provider::new("quota_c", 3, false);
    let fixture = Fixture::new(vec![a.clone(), b.clone(), c.clone()], 3, true).await;
    let first = Invocation::blocked(observed(Some("recovery")));
    let second = Invocation::blocked(observed(Some("sideload")));
    a.push(first.clone());
    b.push(second.clone());
    let a_job = fixture.submit(&a, true, json!({})).await;
    let b_job = fixture.submit(&b, false, json!({})).await;
    until("两项真实执行器 poll", || {
        (a.discovery_calls() == 1 && b.discovery_calls() == 1).then_some(())
    })
    .await;
    let count = fixture.store.jobs().len();
    assert_eq!(
        code(
            guarded(
                "第三入口额度拒绝",
                fixture.devices.refresh(fixture.identity(&c))
            )
            .await
        ),
        "conflict"
    );
    assert_eq!(fixture.store.jobs().len(), count);
    assert_eq!(c.discovery_calls(), 0);
    guarded(
        "取消仍占额度的任务",
        fixture.app.cancel_async(a_job.id.clone()),
    )
    .await
    .unwrap();
    until("取消开始但清理未确认", || {
        first.cancellation_seen.load(Ordering::SeqCst).then_some(())
    })
    .await;
    assert!(!first.cleaned.load(Ordering::SeqCst));
    assert_eq!(
        code(
            guarded(
                "清理未确认时额度仍满",
                fixture.devices.refresh(fixture.identity(&c))
            )
            .await
        ),
        "conflict"
    );
    assert_eq!(fixture.store.jobs().len(), count);
    first.finish_cleanup();
    fixture.wait_terminal(&a_job.id).await;
    guarded(
        "等 A owner 跟踪任务完整收敛",
        fixture.plugins.unload(a.id.clone()),
    )
    .await
    .unwrap();
    let directory = fixture.refresh(&c).await;
    assert_eq!(directory.provider.id, c.id);
    second.finish();
    fixture.wait_directory(&b, &b_job.id).await;
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn a_success_storage_gate_keeps_same_provider_b_from_executing() {
    let provider = Provider::new("serial", 3, false);
    let fixture = Fixture::new(vec![provider.clone()], 2, true).await;
    let gate = fixture
        .store
        .hold(&provider.operation(), Phase::AfterSuccess);
    let a = fixture.submit(&provider, false, json!({})).await;
    until("A 历史成功但存储返回暂停", || gate.reached()).await;
    success(&fixture.store.get(&a.id).unwrap());
    assert!(fixture.directory(&provider).is_none());
    let b = fixture.submit(&provider, true, json!({})).await;
    turns().await;
    assert_eq!(
        provider.discovery_calls(),
        1,
        "B 不能越过 A 的发布/收敛窗口"
    );
    assert_ne!(
        fixture.store.get(&b.id).unwrap().status,
        JobStatus::Succeeded
    );
    gate.release();
    fixture.wait_directory(&provider, &b.id).await;
    assert_eq!(provider.discovery_calls(), 2);
    assert_eq!(provider.maximum_active.load(Ordering::SeqCst), 1);
    fixture.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn discovery_schema_must_accept_empty_object_without_partial_registration() {
    let provider = Provider::new("bad_schema", 3, false);
    *provider.schema.lock().unwrap() =
        json!({"type":"object","required":["file"],"properties":{"file":{"type":"string"}}});
    let store = std::sync::Arc::new(crate::fixtures::store::Store::default());
    let app = apk_application::Application::new_with_bindings(
        store.clone(),
        vec![],
        2,
        16,
        fixtures::bindings(&provider.id),
    )
    .unwrap();
    struct Catalog(std::sync::Arc<Provider>);
    #[async_trait::async_trait]
    impl apk_domain::plugins::PluginCatalog for Catalog {
        async fn load(
            &self,
            id: &str,
        ) -> apk_domain::Result<apk_domain::plugins::PluginContribution> {
            Ok(apk_domain::plugins::PluginContribution {
                id: id.into(),
                version: "1".into(),
                executor: self.0.clone(),
            })
        }
    }
    let plugins = apk_application::plugin_lifecycle::PluginService::new(
        app.clone(),
        std::sync::Arc::new(Catalog(provider.clone())),
        Default::default(),
    );
    assert_eq!(
        code(
            guarded(
                "拒绝不接受空对象的发现模式",
                plugins.load(provider.id.clone())
            )
            .await
        ),
        "invalid_input"
    );
    assert!(app.operation(ALIAS).is_none());
    assert!(app.operation(&provider.operation()).is_none());
    assert!(
        apk_application::devices::DeviceService::new(app.clone())
            .providers()
            .is_empty()
    );
    assert!(store.jobs().is_empty());
    assert_eq!(provider.discovery_calls(), 0);
    plugins.close();
    guarded("管理任务收敛", plugins.wait()).await;
    guarded("应用停止", app.shutdown()).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn old_api_definitions_keep_none_raw_and_use_the_same_direct_discovery_path() {
    for api_version in [1, 2] {
        let provider = Provider::new("old_api", api_version, false);
        let fixture = Fixture::new(vec![provider.clone()], 2, false).await;
        let job = fixture.submit(&provider, false, json!({})).await;
        let directory = fixture.wait_directory(&provider, &job.id).await;
        assert_eq!(directory.provider.definition.api_version, api_version);
        assert!(
            serde_json::to_value(&directory).unwrap()["devices"][0]
                .get("raw_state")
                .is_none()
        );
        success(&fixture.store.get(&job.id).unwrap());
        assert_eq!(fixture.store.jobs().len(), 1);
        assert_eq!(provider.discovery_calls(), 1);
        assert_eq!(
            provider.calls()[0].deadline.unwrap() - provider.calls()[0].started_at,
            std::time::Duration::from_secs(30)
        );
        fixture.shutdown().await;
    }
}
