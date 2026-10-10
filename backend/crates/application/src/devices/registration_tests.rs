//! 在创建历史之后毒化注册锁，验证登记与补偿失败均有明确收敛边界。
use super::attempt_tests::Empty;
use crate::Application;
use apk_domain::{
    Error, Executor, Job, JobEvent, JobStatus, JobStore, Operation, Result,
    devices::DeviceProviderDefinition, plugins::PluginContribution,
};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

struct Probe(AtomicUsize);
#[async_trait]
impl Executor for Probe {
    fn operations(&self) -> Vec<Operation> {
        Empty.operations()
    }
    fn device_provider(&self) -> Option<DeviceProviderDefinition> {
        Empty.device_provider()
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!([]))
    }
}

struct PoisonStore {
    inner: SqliteStore,
    application: Mutex<Weak<Application>>,
    fail_compensation: bool,
}
impl JobStore for PoisonStore {
    fn create(&self, job: &Job) -> Result<()> {
        self.inner.create(job)?;
        let app = self.application.lock().unwrap().upgrade().unwrap();
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = app.registry.0.write().unwrap();
            panic!("定向模拟历史创建后的注册锁异常");
        }));
        assert!(poisoned.is_err());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<Job> {
        self.inner.get(id)
    }
    fn list(&self, limit: usize) -> Result<Vec<Job>> {
        self.inner.list(limit)
    }
    fn events(&self, id: &str, after: u64) -> Result<Vec<JobEvent>> {
        self.inner.events(id, after)
    }
    fn recover(&self) -> Result<()> {
        self.inner.recover()
    }
    fn transition(
        &self,
        id: &str,
        status: JobStatus,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<Job> {
        let app = self.application.lock().unwrap().upgrade().unwrap();
        assert!(app.active.try_lock().is_ok(), "终态补偿不得持有准入锁");
        if self.fail_compensation {
            return Err(Error::Storage("定向模拟终态补偿失败".into()));
        }
        self.inner.transition(id, status, result, error)
    }
}

async fn registration_failure(fail_compensation: bool) {
    let store = Arc::new(PoisonStore {
        inner: SqliteStore::open(":memory:").unwrap(),
        application: Mutex::new(Weak::new()),
        fail_compensation,
    });
    let app = Application::new(store.clone(), vec![], 1, 8).unwrap();
    *store.application.lock().unwrap() = Arc::downgrade(&app);
    let probe = Arc::new(Probe(AtomicUsize::new(0)));
    app.registry
        .publish(
            crate::registry::Prepared::new(PluginContribution {
                id: "gate".into(),
                version: "1".into(),
                executor: probe.clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let error = app
        .submit_async("plugin.gate.discover".into(), json!({}))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage_failed");
    let jobs = store.list(8).unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        jobs[0].status,
        if fail_compensation {
            JobStatus::Queued
        } else {
            JobStatus::Failed
        }
    );
    if fail_compensation {
        assert!(error.to_string().contains("终态补偿失败"));
        assert!(
            error.to_string().contains(&jobs[0].id),
            "恢复记录关联实际未收敛任务"
        );
    }
    assert_eq!(probe.0.load(Ordering::SeqCst), 0);
    assert!(app.registry.directories().is_empty());
    let active = app.active.lock().unwrap();
    assert!(active.tokens.is_empty() && active.discoveries.is_empty());
    drop(active);
    assert_eq!(app.device_refreshes.available_permits(), 2);
    assert!(app.tracker.is_empty());
}

#[tokio::test]
async fn registration_failure_compensates_created_job_without_execution_or_permit_leak() {
    registration_failure(false).await;
}

#[tokio::test]
async fn compensation_failure_preserves_job_identity_and_releases_admission() {
    registration_failure(true).await;
}
