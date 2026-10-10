//! 用例层期限回归：真实任务准入、工作池/设备屏障等待和旧声明兼容。
use super::*;
use apk_domain::{ExecutionContext, Executor, JobStatus, Operation, plugins::PluginContribution};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{sync::Mutex, time::Duration};
use tokio_util::sync::CancellationToken;

struct Probe {
    api_version: u32,
    budget: Option<u64>,
    contexts: Mutex<Vec<ExecutionContext>>,
}
#[async_trait]
impl Executor for Probe {
    fn operations(&self) -> Vec<Operation> {
        ["discover", "work"]
            .map(|name| Operation {
                execution: None,
                id: format!("plugin.deadline.{name}"),
                title: "期限测试".into(),
                input_schema: json!({"type":"object"}),
            })
            .to_vec()
    }
    fn device_provider(&self) -> Option<DeviceProviderDefinition> {
        Some(DeviceProviderDefinition {
            api_version: self.api_version,
            platform: "模拟".into(),
            discover_operation: "plugin.deadline.discover".into(),
            capabilities: vec![DeviceCapability {
                id: "work".into(),
                version: 1,
                operation: "plugin.deadline.work".into(),
                scope: CapabilityScope::Provider,
                access: CapabilityAccess::Write,
                execution_timeout_ms: self.budget,
            }],
        })
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        panic!("任务必须经上下文入口执行")
    }
    async fn execute_with_context(
        &self,
        _: &str,
        _: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        self.contexts.lock().unwrap().push(context);
        cancel.cancelled().await;
        Err(Error::Cancelled)
    }
}
fn setup(version: u32, budget: Option<u64>) -> (Arc<Application>, Arc<Probe>) {
    let app = Application::new(
        Arc::new(apk_infrastructure::store::SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let probe = Arc::new(Probe {
        api_version: version,
        budget,
        contexts: Mutex::new(vec![]),
    });
    app.registry
        .publish(
            crate::registry::Prepared::new(PluginContribution {
                id: "deadline".into(),
                version: "1".into(),
                executor: probe.clone(),
            })
            .unwrap(),
        )
        .unwrap();
    (app, probe)
}
async fn spin_until(mut ready: impl FnMut() -> bool) {
    // 持续让出执行权而不等待定时器，避免暂停时钟在阻塞存储等待时自动前进。
    for _ in 0..100_000 {
        if ready() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("任务未达到期限测试观测点")
}
fn input() -> Value {
    json!({"device_id":null,"input":{}})
}

#[tokio::test(start_paused = true)]
async fn declared_long_budget_survives_sixty_seconds_and_default_stays_thirty() {
    for (version, budget, seconds) in [(1, None, 30), (2, None, 30), (2, Some(120_000), 120)] {
        let (app, probe) = setup(version, budget);
        let admitted_at = tokio::time::Instant::now();
        let job = app.submit("plugin.deadline.work", input()).unwrap();
        spin_until(|| probe.contexts.lock().unwrap().len() == 1).await;
        assert_eq!(
            tokio::time::Instant::from_std(probe.contexts.lock().unwrap()[0].deadline.unwrap()),
            admitted_at + Duration::from_secs(seconds)
        );
        tokio::time::advance(Duration::from_secs(seconds - 1)).await;
        assert_eq!(app.get(&job.id).unwrap().status, JobStatus::Running);
        tokio::time::advance(Duration::from_secs(1)).await;
        spin_until(|| app.get(&job.id).unwrap().status.is_terminal()).await;
        let terminal = app.get(&job.id).unwrap();
        assert_eq!(terminal.status, JobStatus::Failed);
        assert_eq!(terminal.error.as_deref(), Some("执行超时"));
        app.shutdown().await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn worker_wait_consumes_budget_and_expired_job_never_enters_executor() {
    let (app, probe) = setup(2, Some(1000));
    let held = app.workers.clone().acquire_owned().await.unwrap();
    let job = app.submit("plugin.deadline.work", input()).unwrap();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(1)).await;
    spin_until(|| app.get(&job.id).unwrap().status.is_terminal()).await;
    drop(held);
    assert!(probe.contexts.lock().unwrap().is_empty());
    assert_eq!(app.get(&job.id).unwrap().error.as_deref(), Some("执行超时"));
    app.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn provider_barrier_wait_reduces_remaining_execution_budget() {
    let (app, probe) = setup(2, Some(1000));
    let held = app
        .device_locks
        .selection(
            "deadline",
            None,
            &CapabilityScope::Provider,
            &CapabilityAccess::Write,
        )
        .unwrap()
        .acquire(&CancellationToken::new())
        .await
        .unwrap();
    let admitted_at = tokio::time::Instant::now();
    let job = app.submit("plugin.deadline.work", input()).unwrap();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(700)).await;
    assert!(probe.contexts.lock().unwrap().is_empty());
    drop(held);
    spin_until(|| probe.contexts.lock().unwrap().len() == 1).await;
    assert_eq!(
        tokio::time::Instant::from_std(probe.contexts.lock().unwrap()[0].deadline.unwrap()),
        admitted_at + Duration::from_secs(1)
    );
    tokio::time::advance(Duration::from_millis(300)).await;
    spin_until(|| app.get(&job.id).unwrap().status.is_terminal()).await;
    assert_eq!(app.get(&job.id).unwrap().error.as_deref(), Some("执行超时"));
    app.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn discovery_jobs_default_to_thirty_seconds_and_refresh_inherits_earlier_point() {
    for inherited in [false, true] {
        let (app, probe) = setup(2, Some(120_000));
        let start = tokio::time::Instant::now();
        let deadline = start + Duration::from_secs(if inherited { 2 } else { 30 });
        let registered = app.registry.find("plugin.deadline.discover").unwrap();
        let job = app
            .submit_registered_until(
                "plugin.deadline.discover",
                json!({}),
                registered,
                None,
                inherited.then_some(deadline),
            )
            .unwrap();
        spin_until(|| probe.contexts.lock().unwrap().len() == 1).await;
        assert_eq!(
            tokio::time::Instant::from_std(probe.contexts.lock().unwrap()[0].deadline.unwrap()),
            deadline
        );
        tokio::time::advance(deadline - start).await;
        spin_until(|| app.get(&job.id).unwrap().status.is_terminal()).await;
        assert_eq!(app.get(&job.id).unwrap().error.as_deref(), Some("执行超时"));
        app.shutdown().await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn expired_refresh_neither_submits_nor_publishes_directory() {
    let (app, probe) = setup(1, None);
    let deadline = tokio::time::Instant::now();
    let registered = app.registry.find("plugin.deadline.discover").unwrap();
    assert!(matches!(
        app.submit_registered_until(
            "plugin.deadline.discover",
            json!({}),
            registered,
            None,
            Some(deadline)
        ),
        Err(Error::Timeout)
    ));
    assert!(app.list(10).unwrap().is_empty());
    assert!(probe.contexts.lock().unwrap().is_empty());
    let provider = app.registry.providers().pop().unwrap();
    let directory = DeviceDirectory {
        provider,
        observed_at: 1,
        discovery_job_id: "late".into(),
        devices: vec![],
    };
    assert!(matches!(
        app.registry
            .publish_directory(directory, &CancellationToken::new(), deadline),
        Err(Error::Timeout)
    ));
    assert!(app.registry.directories().is_empty());
    app.shutdown().await.unwrap();
}
