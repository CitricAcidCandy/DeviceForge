use super::*;
use apk_domain::{Executor, Operation, plugins::PluginContribution};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

struct Fixture {
    unresolved: AtomicBool,
    calls: AtomicUsize,
    fail: AtomicBool,
    waiting: AtomicBool,
    entered: Notify,
    release: Notify,
    seen: std::sync::Mutex<Option<Value>>,
    supported: bool,
}
#[async_trait]
impl Executor for Fixture {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: "plugin.recover-test.echo".into(),
            title: "回显".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        }]
    }
    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::Acquire)
    }
    fn recovery_timeout(&self) -> Option<Duration> {
        self.supported.then_some(Duration::from_secs(2))
    }
    async fn execute(&self, _: &str, input: Value, _: CancellationToken) -> Result<Value> {
        Ok(input)
    }
    async fn recover_resources(
        &self,
        input: Value,
        _: CancellationToken,
        _: ExecutionContext,
    ) -> Result<RecoveryReport> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        *self.seen.lock().unwrap() = Some(input);
        self.entered.notify_one();
        if self.waiting.load(Ordering::Acquire) {
            self.release.notified().await;
        }
        if self.fail.load(Ordering::Acquire) {
            return Ok(RecoveryReport::blocked("仍有未确认资源"));
        }
        self.unresolved.store(false, Ordering::Release);
        Ok(RecoveryReport {
            coverage: "plugin".into(),
            inspected: 1,
            remaining: 0,
            status: RecoveryStatus::Recovered,
            message: "全部已核对".into(),
            checks: vec![RecoveryCheck {
                resource: "测试资源".into(),
                status: CheckStatus::Confirmed,
                message: "已退出".into(),
            }],
        })
    }
}
fn setup(supported: bool) -> (Arc<Application>, Arc<Fixture>, Arc<Owner>) {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        4,
    )
    .unwrap();
    let executor = Arc::new(Fixture {
        unresolved: AtomicBool::new(true),
        calls: AtomicUsize::new(0),
        fail: AtomicBool::new(false),
        waiting: AtomicBool::new(false),
        entered: Notify::new(),
        release: Notify::new(),
        supported,
        seen: std::sync::Mutex::new(None),
    });
    let prepared = crate::registry::Prepared::new(PluginContribution {
        id: "recover-test".into(),
        version: "1".into(),
        executor: executor.clone(),
    })
    .unwrap();
    app.registry.publish(prepared).unwrap();
    let owner = app.registry.0.read().unwrap().owners["recover-test"].clone();
    owner.mark_unresolved();
    (app, executor, owner)
}
fn input(owner: &Owner) -> RecoveryInput {
    RecoveryInput {
        generation: owner.info().generation,
        input: json!({}),
    }
}

#[tokio::test]
async fn explicit_confirmation_recovers_same_generation_without_rewriting_history() {
    let (app, executor, owner) = setup(true);
    let before = owner.info().generation;
    let result = app
        .recover_plugin("recover-test".into(), input(&owner))
        .await
        .unwrap();
    assert!(!result.cleanup_failed && !result.recovering);
    assert_eq!(result.generation, before);
    assert_eq!(
        result.last_report.unwrap().status,
        RecoveryStatus::Recovered
    );
    assert_eq!(executor.calls.load(Ordering::Acquire), 1);
}

#[tokio::test]
async fn unsupported_and_stale_generation_never_execute_or_clear_failure() {
    let (app, executor, owner) = setup(false);
    assert!(
        app.recover_plugin("recover-test".into(), input(&owner))
            .await
            .is_err()
    );
    let (other, current, current_owner) = setup(true);
    let mut request = input(&current_owner);
    request.generation = "old".into();
    assert!(
        other
            .recover_plugin("recover-test".into(), request)
            .await
            .is_err()
    );
    assert!(owner.info().cleanup_failed && current_owner.info().cleanup_failed);
    assert_eq!(
        executor.calls.load(Ordering::Acquire) + current.calls.load(Ordering::Acquire),
        0
    );
}

#[tokio::test]
async fn active_credentials_return_busy_without_interruption() {
    let (app, executor, owner) = setup(true);
    let active = owner.claim().unwrap();
    let result = app
        .recover_plugin("recover-test".into(), input(&owner))
        .await
        .unwrap();
    assert_eq!(result.last_report.unwrap().status, RecoveryStatus::Busy);
    assert_eq!(executor.calls.load(Ordering::Acquire), 0);
    assert!(owner.info().cleanup_failed);
    drop(active);
}

#[tokio::test]
async fn dropped_http_waiter_keeps_admission_frozen_and_prevents_unload() {
    let (app, executor, owner) = setup(true);
    executor.waiting.store(true, Ordering::Release);
    let application = app.clone();
    let request = input(&owner);
    let waiting = tokio::spawn(async move {
        application
            .recover_plugin("recover-test".into(), request)
            .await
    });
    executor.entered.notified().await;
    waiting.abort();
    assert!(owner.recovering.load(Ordering::Acquire));
    assert!(owner.claim().is_err());
    assert!(app.registry.detach("recover-test").is_err());
    let duplicate = app
        .recover_plugin("recover-test".into(), input(&owner))
        .await
        .unwrap();
    assert_eq!(duplicate.last_report.unwrap().status, RecoveryStatus::Busy);
    executor.release.notify_one();
    tokio::time::timeout(Duration::from_secs(2), async {
        while owner.recovering.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!owner.info().cleanup_failed);
}

#[tokio::test]
async fn newer_failure_cannot_be_overwritten_by_late_recovery_success() {
    let (app, executor, owner) = setup(true);
    executor.waiting.store(true, Ordering::Release);
    let application = app.clone();
    let request = input(&owner);
    let waiting = tokio::spawn(async move {
        application
            .recover_plugin("recover-test".into(), request)
            .await
    });
    executor.entered.notified().await;
    owner.mark_unresolved();
    executor.release.notify_one();
    let result = waiting.await.unwrap().unwrap();
    assert!(result.cleanup_failed);
    assert_eq!(result.last_report.unwrap().status, RecoveryStatus::Blocked);
}

#[tokio::test]
async fn repeated_failure_never_becomes_recovered_and_may_be_retried_explicitly() {
    let (app, executor, owner) = setup(true);
    executor.fail.store(true, Ordering::Release);
    for _ in 0..2 {
        let result = app
            .recover_plugin("recover-test".into(), input(&owner))
            .await
            .unwrap();
        assert!(result.cleanup_failed && !result.recovering);
        assert_eq!(result.last_report.unwrap().status, RecoveryStatus::Blocked);
    }
    executor.fail.store(false, Ordering::Release);
    assert!(
        !app.recover_plugin("recover-test".into(), input(&owner))
            .await
            .unwrap()
            .cleanup_failed
    );
}

#[tokio::test]
async fn finished_session_performs_one_automatic_audit_without_replaying_business() {
    let (app, executor, owner) = setup(true);
    app.auto_recover_finished_session(owner.clone(), json!({"device_id":"example"}))
        .await;
    assert!(!owner.info().cleanup_failed);
    assert_eq!(executor.calls.load(Ordering::Acquire), 1);
    app.auto_recover_finished_session(owner.clone(), json!({}))
        .await;
    assert_eq!(executor.calls.load(Ordering::Acquire), 1);
    executor.fail.store(true, Ordering::Release);
    owner.mark_unresolved();
    app.auto_recover_finished_session(owner.clone(), json!({}))
        .await;
    assert_eq!(executor.calls.load(Ordering::Acquire), 2);
    assert!(owner.info().cleanup_failed);
}

#[tokio::test]
async fn client_cannot_hide_cleanup_risk_from_plugin_global_audit() {
    let (app, executor, owner) = setup(true);
    let mut request = input(&owner);
    request.input = json!({"_host_cleanup_unconfirmed":false});
    app.recover_plugin("recover-test".into(), request).await.unwrap();
    assert_eq!(executor.seen.lock().unwrap().as_ref().unwrap()["_host_cleanup_unconfirmed"], true);
}
