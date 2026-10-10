//! 同步创建暂停时，准入、取消与owner排空仍可继续；只使用内存存储门闩。
use super::attempt_tests::{Empty, attempt, directory};
use crate::{Application, plugin_lifecycle::PluginService};
use apk_domain::{
    Error, Executor, Job, JobEvent, JobStatus, JobStore, Operation, Result,
    devices::DeviceProviderDefinition,
    plugins::{PluginCatalog, PluginContribution},
};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Gate {
    enabled: AtomicBool,
    state: Mutex<(Option<String>, bool)>,
    wake: Condvar,
}
impl Gate {
    fn arm(&self) {
        self.enabled.store(true, Ordering::SeqCst);
    }
    fn id(&self) -> Option<String> {
        self.state.lock().unwrap().0.clone()
    }
    fn release(&self) {
        self.state.lock().unwrap().1 = true;
        self.wake.notify_all();
    }
    fn wait(&self, id: &str) -> Result<()> {
        if !self.enabled.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut state = self.state.lock().unwrap();
        state.0 = Some(id.into());
        let (state, timeout) = self
            .wake
            .wait_timeout_while(state, Duration::from_secs(3), |state| !state.1)
            .unwrap();
        if timeout.timed_out() && !state.1 {
            return Err(Error::Storage("创建验收门闩超时".into()));
        }
        Ok(())
    }
}
struct Store {
    inner: SqliteStore,
    create: Gate,
    compensation: Gate,
}
impl JobStore for Store {
    fn create(&self, job: &Job) -> Result<()> {
        self.create.wait(&job.id)?;
        self.inner.create(job)
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
        output: Option<Value>,
        error: Option<String>,
    ) -> Result<Job> {
        if matches!(status, JobStatus::Failed | JobStatus::Cancelled) {
            self.compensation.wait(id)?;
        }
        self.inner.transition(id, status, output, error)
    }
}
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
struct Catalog;
#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, _: &str) -> Result<PluginContribution> {
        Err(Error::Dependency("本夹具不加载真实部署".into()))
    }
}
struct Fixture {
    app: Arc<Application>,
    store: Arc<Store>,
    probe: Arc<Probe>,
}
impl Fixture {
    fn new(capacity: usize) -> Self {
        let store = Arc::new(Store {
            inner: SqliteStore::open(":memory:").unwrap(),
            create: Gate::default(),
            compensation: Gate::default(),
        });
        let app = Application::new(store.clone(), vec![], 1, capacity).unwrap();
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
        Self { app, store, probe }
    }
    fn submit(&self) -> tokio::task::JoinHandle<Result<Job>> {
        let app = self.app.clone();
        tokio::spawn(async move {
            app.submit_async("plugin.gate.discover".into(), json!({}))
                .await
        })
    }
    async fn creating(&self) -> String {
        wait(|| self.store.create.id()).await
    }
    fn empty(&self) {
        let active = self.app.active.lock().unwrap();
        assert!(
            active.creating.is_empty() && active.tokens.is_empty() && active.discoveries.is_empty()
        );
        assert_eq!(self.app.device_refreshes.available_permits(), 2);
        assert!(self.app.tracker.is_empty());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.store.create.release();
        self.store.compensation.release();
    }
}
async fn wait<T>(mut observe: impl FnMut() -> Option<T>) -> T {
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(value) = observe() {
            return value;
        }
        assert!(Instant::now() < until, "未达到创建阶段观察点");
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn blocked_create_does_not_delay_another_pending_discovery_cancel() {
    let fixture = Fixture::new(8);
    let a = attempt(&fixture.app, "pending-a", None);
    fixture.app.registry.begin_discovery(&a).unwrap();
    {
        let mut active = fixture.app.active.lock().unwrap();
        active.tokens.insert(a.job_id.clone(), a.token.clone());
        active.discoveries.insert(a.job_id.clone(), a.clone());
    }
    fixture.store.create.arm();
    let b = fixture.submit();
    fixture.creating().await;
    assert!(
        fixture.app.active.try_lock().is_ok(),
        "创建中的存储不能持准入锁"
    );
    fixture.app.request_cancel(&a.job_id).unwrap();
    assert!(matches!(
        fixture.app.registry.accept_discovery(&a, directory(&a)),
        Err(Error::Cancelled)
    ));
    assert_eq!(fixture.probe.0.load(Ordering::SeqCst), 0);
    {
        let mut active = fixture.app.active.lock().unwrap();
        active.tokens.remove(&a.job_id);
        active.discoveries.remove(&a.job_id);
    }
    fixture.app.registry.forget_discovery(&a);
    a.finish();
    fixture.store.create.release();
    let job = b.await.unwrap().unwrap();
    wait(|| {
        fixture
            .store
            .get(&job.id)
            .ok()
            .filter(|job| job.status.is_terminal())
    })
    .await;
    fixture.app.shutdown().await.unwrap();
    fixture.empty();
}

#[tokio::test(flavor = "current_thread")]
async fn shutdown_cancels_creating_reservation_and_waits_for_compensation_without_starting_it() {
    let fixture = Fixture::new(8);
    let previous = attempt(&fixture.app, "previous", None);
    fixture.app.registry.begin_discovery(&previous).unwrap();
    fixture
        .app
        .registry
        .accept_discovery(&previous, directory(&previous))
        .unwrap();
    previous.finish();
    fixture.app.registry.forget_discovery(&previous);
    fixture.store.create.arm();
    let b = fixture.submit();
    let id = fixture.creating().await;
    assert!(fixture.app.active.try_lock().is_ok());
    let app = fixture.app.clone();
    let shutdown = tokio::spawn(async move { app.shutdown().await });
    wait(|| {
        fixture
            .app
            .active
            .try_lock()
            .ok()
            .filter(|active| !active.accepting)
            .map(|_| ())
    })
    .await;
    assert!(!shutdown.is_finished());
    assert!(matches!(
        fixture
            .app
            .submit_async("plugin.gate.discover".into(), json!({}))
            .await,
        Err(Error::Conflict(_))
    ));
    fixture.store.create.release();
    assert!(matches!(b.await.unwrap(), Err(Error::Cancelled)));
    shutdown.await.unwrap().unwrap();
    assert_eq!(fixture.store.get(&id).unwrap().status, JobStatus::Cancelled);
    assert_eq!(fixture.probe.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.app.registry.directories()[0].discovery_job_id,
        "previous"
    );
    fixture.empty();
}

#[tokio::test(flavor = "current_thread")]
async fn unload_waits_for_creating_and_compensating_old_owner_before_finishing() {
    let fixture = Fixture::new(8);
    let owner = fixture.app.registry.0.read().unwrap().owners["gate"].clone();
    let plugins = PluginService::new(fixture.app.clone(), Arc::new(Catalog), Default::default());
    fixture.store.create.arm();
    fixture.store.compensation.arm();
    let b = fixture.submit();
    let id = fixture.creating().await;
    assert!(fixture.app.active.try_lock().is_ok());
    let service = plugins.clone();
    let unloading = tokio::spawn(async move { service.unload("gate".into()).await });
    wait(|| fixture.app.operations().is_empty().then_some(())).await;
    assert!(!unloading.is_finished() && !owner.tracker.is_empty());
    fixture.store.create.release();
    wait(|| fixture.store.compensation.id()).await;
    assert!(
        !unloading.is_finished() && !owner.tracker.is_empty(),
        "历史补偿也属于旧owner排空"
    );
    assert_eq!(fixture.probe.0.load(Ordering::SeqCst), 0);
    fixture.store.compensation.release();
    assert!(matches!(b.await.unwrap(), Err(Error::Conflict(_))));
    unloading.await.unwrap().unwrap();
    assert!(owner.tracker.is_empty());
    assert_eq!(fixture.store.get(&id).unwrap().status, JobStatus::Failed);
    fixture.app.shutdown().await.unwrap();
    fixture.empty();
}

#[tokio::test(flavor = "current_thread")]
async fn creating_reservation_counts_toward_capacity_before_history_is_created() {
    let fixture = Fixture::new(1);
    fixture.store.create.arm();
    let b = fixture.submit();
    let id = fixture.creating().await;
    assert!(fixture.app.active.try_lock().is_ok());
    assert!(matches!(
        fixture
            .app
            .submit_async("plugin.gate.discover".into(), json!({}))
            .await,
        Err(Error::Conflict(_))
    ));
    assert!(fixture.store.list(8).unwrap().is_empty());
    fixture.store.create.release();
    b.await.unwrap().unwrap();
    wait(|| {
        fixture
            .store
            .get(&id)
            .ok()
            .filter(|job| job.status.is_terminal())
    })
    .await;
    fixture.app.shutdown().await.unwrap();
    fixture.empty();
}

#[tokio::test(flavor = "current_thread")]
async fn cancel_revokes_discovery_even_after_job_success_has_claimed_commit() {
    let fixture = Fixture::new(1);
    let attempt = attempt(&fixture.app, "committing-discovery", None);
    fixture.app.registry.begin_discovery(&attempt).unwrap();
    let completion = crate::completion::Completion::new();
    let claim = completion.claim(None, &attempt.token).unwrap();
    {
        let mut active = fixture.app.active.lock().unwrap();
        active
            .tokens
            .insert(attempt.job_id.clone(), attempt.token.clone());
        active
            .completions
            .insert(attempt.job_id.clone(), completion.clone());
        active
            .discoveries
            .insert(attempt.job_id.clone(), attempt.clone());
    }
    fixture.app.request_cancel(&attempt.job_id).unwrap();
    assert!(!completion.request_cancel().unwrap(), "Job资格仍归先取得者");
    assert!(matches!(
        fixture
            .app
            .registry
            .accept_discovery(&attempt, directory(&attempt)),
        Err(Error::Cancelled)
    ));
    drop(claim);
    {
        let mut active = fixture.app.active.lock().unwrap();
        active.tokens.remove(&attempt.job_id);
        active.completions.remove(&attempt.job_id);
        active.discoveries.remove(&attempt.job_id);
    }
    fixture.app.registry.forget_discovery(&attempt);
    attempt.finish();
    fixture.app.shutdown().await.unwrap();
    fixture.empty();
}

#[tokio::test(flavor = "current_thread")]
async fn shutdown_revokes_discovery_without_rewriting_an_already_committed_job() {
    let fixture = Fixture::new(1);
    let attempt = attempt(&fixture.app, "committed-discovery", None);
    fixture.app.registry.begin_discovery(&attempt).unwrap();
    let queued = Job {
        id: attempt.job_id.clone(),
        operation: "plugin.gate.discover".into(),
        input: json!({}),
        status: JobStatus::Queued,
        result: None,
        error: None,
        created_at: 0,
    };
    fixture.store.create(&queued).unwrap();
    fixture
        .store
        .transition(&queued.id, JobStatus::Running, None, None)
        .unwrap();
    let completion = crate::completion::Completion::new();
    let claim = completion.claim(None, &attempt.token).unwrap();
    let terminal = fixture
        .store
        .transition(&queued.id, JobStatus::Succeeded, Some(json!({})), None)
        .unwrap();
    claim.committed(terminal);
    {
        let mut active = fixture.app.active.lock().unwrap();
        active
            .tokens
            .insert(attempt.job_id.clone(), attempt.token.clone());
        active
            .completions
            .insert(attempt.job_id.clone(), completion);
        active
            .discoveries
            .insert(attempt.job_id.clone(), attempt.clone());
    }
    fixture.app.shutdown().await.unwrap();
    assert_eq!(
        fixture.store.get(&queued.id).unwrap().status,
        JobStatus::Succeeded
    );
    assert!(matches!(
        fixture
            .app
            .registry
            .accept_discovery(&attempt, directory(&attempt)),
        Err(Error::Cancelled)
    ));
    {
        let mut active = fixture.app.active.lock().unwrap();
        active.tokens.remove(&attempt.job_id);
        active.completions.remove(&attempt.job_id);
        active.discoveries.remove(&attempt.job_id);
    }
    fixture.app.registry.forget_discovery(&attempt);
    attempt.finish();
    fixture.empty();
}
