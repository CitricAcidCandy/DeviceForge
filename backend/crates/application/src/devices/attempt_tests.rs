//! 发布决定点与等待者回执的确定性回归，不以端点采样证明原子性。
use super::{attempt::*, *};
use apk_domain::{Executor, Operation, plugins::PluginContribution};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) struct Empty;
#[async_trait]
impl Executor for Empty {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            execution: None,
            id: "plugin.gate.discover".into(),
            title: "发现门禁".into(),
            input_schema: json!({"type":"object"}),
        }]
    }
    fn device_provider(&self) -> Option<DeviceProviderDefinition> {
        Some(DeviceProviderDefinition {
            api_version: 3,
            platform: "模拟".into(),
            discover_operation: "plugin.gate.discover".into(),
            capabilities: vec![],
        })
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        Ok(json!([]))
    }
}
fn setup() -> Arc<Application> {
    let app = Application::new(
        Arc::new(apk_infrastructure::store::SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    app.registry
        .publish(
            crate::registry::Prepared::new(PluginContribution {
                id: "gate".into(),
                version: "1".into(),
                executor: Arc::new(Empty),
            })
            .unwrap(),
        )
        .unwrap();
    app
}
pub(super) fn attempt(
    app: &Application,
    job_id: &str,
    parent: Option<CancellationToken>,
) -> Arc<Attempt> {
    let registered = app.registry.find("plugin.gate.discover").unwrap();
    let plan = crate::alias_plan::Plan::new(&registered, &json!({})).unwrap();
    let admission = admission::Admission::prepare(app, &plan, tokio::time::Instant::now(), None)
        .unwrap()
        .unwrap();
    let result = admission.attempt(job_id.into(), &plan, parent);
    app.registry.track_discovery(&result).unwrap();
    result
}
pub(super) fn directory(attempt: &Attempt) -> DeviceDirectory {
    DeviceDirectory {
        provider: attempt.provider.clone(),
        observed_at: 1,
        discovery_job_id: attempt.job_id.clone(),
        devices: vec![],
    }
}

#[tokio::test]
async fn parent_cancel_request_rejects_acceptance_before_bridge_runs() {
    let app = setup();
    let parent = CancellationToken::new();
    let current = attempt(&app, "parent", Some(parent.clone()));
    app.registry.begin_discovery(&current).unwrap();
    parent.cancel();
    assert!(
        !current.token.is_cancelled(),
        "未运行桥接，子执行令牌还未撤销"
    );
    assert!(matches!(
        app.registry.accept_discovery(&current, directory(&current)),
        Err(Error::Cancelled)
    ));
    current.finish();
    assert!(matches!(current.receipt().await, Err(Error::Cancelled)));
    assert!(app.registry.directories().is_empty());
}

#[tokio::test]
async fn cancel_before_begin_keeps_previous_observation_but_after_begin_does_not_restore_it() {
    let app = setup();
    let previous = attempt(&app, "previous", None);
    app.registry.begin_discovery(&previous).unwrap();
    app.registry
        .accept_discovery(&previous, directory(&previous))
        .unwrap();
    previous.finish();
    let before = attempt(&app, "before", None);
    before.reject(Rejection::Cancelled);
    assert!(matches!(
        app.registry.begin_discovery(&before),
        Err(Error::Cancelled)
    ));
    assert_eq!(app.registry.directories()[0].discovery_job_id, "previous");
    before.finish();
    let after = attempt(&app, "after", None);
    app.registry.begin_discovery(&after).unwrap();
    after.reject(Rejection::Cancelled);
    assert!(app.registry.directories().is_empty());
    assert!(matches!(
        app.registry.accept_discovery(&after, directory(&after)),
        Err(Error::Cancelled)
    ));
    after.finish();
}

#[tokio::test]
async fn accepted_a_receipt_stays_a_after_cancel_and_b_replaces_directory() {
    let app = setup();
    let a = attempt(&app, "a", None);
    app.registry.begin_discovery(&a).unwrap();
    app.registry.accept_discovery(&a, directory(&a)).unwrap();
    a.reject(Rejection::Cancelled);
    a.finish();
    let b = attempt(&app, "b", None);
    app.registry.begin_discovery(&b).unwrap();
    app.registry.accept_discovery(&b, directory(&b)).unwrap();
    b.finish();
    app.registry.forget_discovery(&a);
    assert_eq!(a.receipt().await.unwrap().discovery_job_id, "a");
    assert_eq!(app.registry.directories()[0].discovery_job_id, "b");
    assert_eq!(
        app.registry.0.read().unwrap().discovery_started["gate"].1,
        "b"
    );
}

#[tokio::test]
async fn owner_detach_rejects_pending_but_keeps_accepted_receipt_and_removes_directory() {
    let app = setup();
    let a = attempt(&app, "a", None);
    app.registry.begin_discovery(&a).unwrap();
    app.registry.accept_discovery(&a, directory(&a)).unwrap();
    a.finish();
    let b = attempt(&app, "b", None);
    app.registry.begin_discovery(&b).unwrap();
    app.registry.detach("gate").unwrap();
    assert!(matches!(
        app.registry.accept_discovery(&b, directory(&b)),
        Err(Error::Conflict(_))
    ));
    b.finish();
    assert!(matches!(b.receipt().await, Err(Error::Conflict(_))));
    assert_eq!(a.receipt().await.unwrap().discovery_job_id, "a");
    assert!(app.registry.directories().is_empty());
}

#[tokio::test(start_paused = true)]
async fn pending_acceptance_uses_original_deadline() {
    let app = setup();
    let current = attempt(&app, "late", None);
    app.registry.begin_discovery(&current).unwrap();
    tokio::time::advance(Duration::from_secs(30)).await;
    assert!(matches!(
        app.registry.accept_discovery(&current, directory(&current)),
        Err(Error::Timeout)
    ));
    current.finish();
    assert!(matches!(current.receipt().await, Err(Error::Timeout)));
    assert!(app.registry.directories().is_empty());
}

#[tokio::test]
async fn acceptance_requires_matching_started_attempt() {
    let app = setup();
    let a = attempt(&app, "a", None);
    let b = attempt(&app, "b", None);
    app.registry.begin_discovery(&a).unwrap();
    app.registry.begin_discovery(&b).unwrap();
    assert!(matches!(
        app.registry.accept_discovery(&a, directory(&a)),
        Err(Error::Conflict(_))
    ));
    app.registry.accept_discovery(&b, directory(&b)).unwrap();
    app.registry.forget_discovery(&a);
    a.finish();
    b.finish();
    assert_eq!(app.registry.directories()[0].discovery_job_id, "b");
}

#[tokio::test(start_paused = true)]
async fn storage_pool_wait_consumes_discovery_budget_without_creating_job() {
    let app = setup();
    let mut held = Vec::new();
    for _ in 0..4 {
        held.push(app.storage_workers.clone().acquire_owned().await.unwrap());
    }
    let running_app = app.clone();
    let waiting = tokio::spawn(async move {
        running_app
            .submit_async("plugin.gate.discover".into(), json!({}))
            .await
    });
    for _ in 0..100 {
        tokio::task::yield_now().await;
        if app.device_refreshes.available_permits() == 1 {
            break;
        }
    }
    assert_eq!(app.device_refreshes.available_permits(), 1);
    tokio::time::advance(Duration::from_secs(30)).await;
    tokio::task::yield_now().await;
    drop(held);
    assert!(matches!(waiting.await.unwrap(), Err(Error::Timeout)));
    assert!(app.list(10).unwrap().is_empty());
    assert!(app.registry.directories().is_empty());
    assert_eq!(app.device_refreshes.available_permits(), 2);
    app.shutdown().await.unwrap();
}

fn pending_history(app: &Application, current: &Arc<Attempt>, succeeded: bool) {
    let job = apk_domain::Job {
        id: current.job_id.clone(),
        operation: "plugin.gate.discover".into(),
        input: json!({}),
        status: apk_domain::JobStatus::Queued,
        result: None,
        error: None,
        created_at: 1,
    };
    app.store.create(&job).unwrap();
    if succeeded {
        app.store
            .transition(&job.id, apk_domain::JobStatus::Running, None, None)
            .unwrap();
        app.store
            .transition(
                &job.id,
                apk_domain::JobStatus::Succeeded,
                Some(json!([])),
                None,
            )
            .unwrap();
    }
    let mut active = app.active.lock().unwrap();
    active.tokens.insert(job.id.clone(), current.token.clone());
    active.discoveries.insert(job.id, current.clone());
}

#[tokio::test]
async fn terminal_job_cancel_closes_pending_gate_before_waiting_for_storage_slot() {
    let app = setup();
    let current = attempt(&app, "success-pending", None);
    app.registry.begin_discovery(&current).unwrap();
    pending_history(&app, &current, true);
    let mut held = Vec::new();
    for _ in 0..4 {
        held.push(app.storage_workers.clone().acquire_owned().await.unwrap());
    }
    let cancelled_app = app.clone();
    let cancelling =
        tokio::spawn(async move { cancelled_app.cancel_async("success-pending".into()).await });
    for _ in 0..100 {
        tokio::task::yield_now().await;
        if current.token.is_cancelled() {
            break;
        }
    }
    assert!(current.token.is_cancelled());
    assert!(!cancelling.is_finished());
    assert!(matches!(
        app.registry.accept_discovery(&current, directory(&current)),
        Err(Error::Cancelled)
    ));
    drop(held);
    assert_eq!(
        cancelling.await.unwrap().unwrap().status,
        apk_domain::JobStatus::Succeeded
    );
    assert!(app.registry.directories().is_empty());
    current.finish();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_closes_admission_and_pending_gate_before_storage_slot_is_available() {
    let app = setup();
    let current = attempt(&app, "shutdown", None);
    app.registry.begin_discovery(&current).unwrap();
    pending_history(&app, &current, false);
    let mut held = Vec::new();
    for _ in 0..4 {
        held.push(app.storage_workers.clone().acquire_owned().await.unwrap());
    }
    let stopping_app = app.clone();
    let stopping = tokio::spawn(async move { stopping_app.shutdown().await });
    for _ in 0..100 {
        tokio::task::yield_now().await;
        if current.token.is_cancelled() {
            break;
        }
    }
    assert!(!app.active.lock().unwrap().accepting);
    assert!(!stopping.is_finished());
    assert!(matches!(
        app.registry.accept_discovery(&current, directory(&current)),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        app.submit("plugin.gate.discover", json!({})),
        Err(Error::Conflict(_))
    ));
    drop(held);
    stopping.await.unwrap().unwrap();
    current.finish();
}
