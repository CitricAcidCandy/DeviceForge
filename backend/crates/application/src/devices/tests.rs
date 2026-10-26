use super::*;
use apk_domain::{Executor, Operation, Result, plugins::*};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

struct Invalid;
#[async_trait]
impl Executor for Invalid {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            execution: None,
            id: "plugin.invalid.discover".into(),
            title: "发现".into(),
            input_schema: json!({"type":"object"}),
        }]
    }
    fn device_provider(&self) -> Option<DeviceProviderDefinition> {
        Some(DeviceProviderDefinition {
            api_version: 1,
            platform: "测试".into(),
            discover_operation: "plugin.invalid.missing".into(),
            capabilities: vec![],
        })
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        panic!("无效声明不得执行")
    }
}
#[test]
fn bad_declaration_has_no_partial_publication() {
    let registry = crate::registry::Registry::new(vec![]).unwrap();
    assert!(matches!(
        crate::registry::Prepared::new(PluginContribution {
            id: "invalid".into(),
            version: "1".into(),
            executor: Arc::new(Invalid)
        }),
        Err(Error::Invalid(_))
    ));
    assert!(registry.operations().1.is_empty());
    assert!(registry.providers().is_empty());
}

#[tokio::test]
async fn stable_pool_identity_and_provider_barriers_cover_all_devices() {
    let locks = locks::Locks::default();
    let cancel = CancellationToken::new();
    let write = locks
        .selection(
            "first",
            Some("same"),
            &CapabilityScope::Device,
            &CapabilityAccess::Write,
        )
        .unwrap()
        .acquire(&cancel)
        .await
        .unwrap();
    let same = locks
        .selection(
            "first",
            Some("same"),
            &CapabilityScope::Device,
            &CapabilityAccess::Write,
        )
        .unwrap();
    let other = locks
        .selection(
            "first",
            Some("other"),
            &CapabilityScope::Device,
            &CapabilityAccess::Write,
        )
        .unwrap()
        .acquire(&cancel)
        .await
        .unwrap();
    let other_provider = locks
        .selection(
            "second",
            Some("same"),
            &CapabilityScope::Device,
            &CapabilityAccess::Write,
        )
        .unwrap()
        .acquire(&cancel)
        .await
        .unwrap();
    let mut waiting = Box::pin(same.acquire(&cancel));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut waiting)
            .await
            .is_err()
    );
    drop(write);
    let next = waiting.await.unwrap();
    drop((next, other, other_provider));
    let global = locks
        .selection(
            "first",
            None,
            &CapabilityScope::Provider,
            &CapabilityAccess::Write,
        )
        .unwrap()
        .acquire(&cancel)
        .await
        .unwrap();
    for access in [CapabilityAccess::Read, CapabilityAccess::Write] {
        let action = locks
            .selection("first", Some("same"), &CapabilityScope::Device, &access)
            .unwrap();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                action.acquire(&cancel)
            )
            .await
            .is_err()
        );
    }
    drop(global);
    cancel.cancel();
    assert!(matches!(
        locks
            .selection(
                "first",
                Some("same"),
                &CapabilityScope::Device,
                &CapabilityAccess::Write
            )
            .unwrap()
            .acquire(&cancel)
            .await,
        Err(Error::Cancelled)
    ));
}

#[tokio::test(start_paused = true)]
async fn lock_wait_uses_total_deadline_without_entering_executor() {
    let locks = locks::Locks::default();
    let cancel = CancellationToken::new();
    let held = locks
        .selection(
            "provider",
            Some("device"),
            &CapabilityScope::Device,
            &CapabilityAccess::Write,
        )
        .unwrap()
        .acquire(&cancel)
        .await
        .unwrap();
    let wait = locks
        .selection(
            "provider",
            Some("device"),
            &CapabilityScope::Device,
            &CapabilityAccess::Write,
        )
        .unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let task = tokio::spawn(async move { wait.acquire_until(&cancel, deadline).await });
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_secs(30)).await;
    assert!(matches!(task.await.unwrap(), Err(Error::Timeout)));
    drop(held);
}

#[test]
fn late_directory_cannot_publish_after_owner_is_detached() {
    struct Empty;
    #[async_trait]
    impl Executor for Empty {
        fn operations(&self) -> Vec<Operation> {
            vec![Operation {
                execution: None,
                id: "plugin.test.discover".into(),
                title: "发现".into(),
                input_schema: json!({"type":"object"}),
            }]
        }
        fn device_provider(&self) -> Option<DeviceProviderDefinition> {
            Some(DeviceProviderDefinition {
                api_version: 1,
                platform: "模拟".into(),
                discover_operation: "plugin.test.discover".into(),
                capabilities: vec![],
            })
        }
        async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
            Ok(json!([]))
        }
    }
    let registry = crate::registry::Registry::new(vec![]).unwrap();
    let info = registry
        .publish(
            crate::registry::Prepared::new(PluginContribution {
                id: "test".into(),
                version: "1".into(),
                executor: Arc::new(Empty),
            })
            .unwrap(),
        )
        .unwrap();
    let provider = registry
        .provider_operation("test", &info.generation, None)
        .unwrap()
        .0;
    let directory = DeviceDirectory {
        provider,
        observed_at: 1,
        discovery_job_id: "job".into(),
        devices: vec![],
    };
    registry
        .publish_directory(
            directory.clone(),
            &CancellationToken::new(),
            tokio::time::Instant::now() + std::time::Duration::from_secs(30),
        )
        .unwrap();
    let owner = registry.detach("test").unwrap();
    assert!(registry.directories().is_empty());
    assert!(matches!(
        registry.publish_directory(
            directory,
            &CancellationToken::new(),
            tokio::time::Instant::now() + std::time::Duration::from_secs(30)
        ),
        Err(Error::Conflict(_))
    ));
    registry.finish(&owner).unwrap();
}

#[tokio::test(start_paused = true)]
async fn first_poll_cancel_deadline_and_unresolved_owner_never_start_executor() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    struct Controlled {
        calls: AtomicUsize,
        unresolved: AtomicBool,
    }
    #[async_trait]
    impl Executor for Controlled {
        fn operations(&self) -> Vec<Operation> {
            vec![Operation {
                execution: None,
                id: "plugin.guard.work".into(),
                title: "首次执行卫兵".into(),
                input_schema: json!({"type":"object"}),
            }]
        }
        fn has_unresolved_resources(&self) -> bool {
            self.unresolved.load(Ordering::SeqCst)
        }
        async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({}))
        }
    }
    let worker = Arc::new(Controlled {
        calls: AtomicUsize::new(0),
        unresolved: AtomicBool::new(false),
    });
    let registry = crate::registry::Registry::new(vec![]).unwrap();
    registry
        .publish(
            crate::registry::Prepared::new(PluginContribution {
                id: "guard".into(),
                version: "1".into(),
                executor: worker.clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let registered = registry.find("plugin.guard.work").unwrap();
    let token = CancellationToken::new();
    let future = crate::execution::execute(
        worker.as_ref(),
        "plugin.guard.work",
        json!({}),
        token.clone(),
        registered.owner.as_deref(),
        None,
    );
    token.cancel();
    assert!(matches!(future.await, Err(Error::Cancelled)));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let future = crate::execution::execute(
        worker.as_ref(),
        "plugin.guard.work",
        json!({}),
        CancellationToken::new(),
        registered.owner.as_deref(),
        Some(deadline),
    );
    tokio::time::advance(std::time::Duration::from_secs(30)).await;
    assert!(matches!(future.await, Err(Error::Timeout)));
    let future = crate::execution::execute(
        worker.as_ref(),
        "plugin.guard.work",
        json!({}),
        CancellationToken::new(),
        registered.owner.as_deref(),
        None,
    );
    worker.unresolved.store(true, Ordering::SeqCst);
    assert!(future.await.is_ok());
    assert_eq!(worker.calls.load(Ordering::SeqCst), 1);
}
