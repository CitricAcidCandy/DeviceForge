//! 历史清理债务只作可观察状态，不得封锁独立调用或污染另一笔任务的完成资格。
#[allow(dead_code)]
#[path = "devices/support.rs"]
mod device_fixture;
#[allow(dead_code)]
#[path = "ordinary_deadline/gate.rs"]
mod gate;
#[allow(dead_code)]
#[path = "performance_lifecycle/fixture.rs"]
mod performance_fixture;
#[allow(dead_code)]
#[path = "ordinary_deadline/store.rs"]
mod store;

use apk_application::{Application, plugin_lifecycle::PluginService};
use apk_domain::{
    Error, Executor, Job, JobStatus, JobStore, Operation, Result,
    performance::{PerformanceSamples, PerformanceState},
    plugins::{PluginCatalog, PluginContribution, PluginInfo, PluginState},
};
use apk_infrastructure::performance::store::SqlitePerformance;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use store::Store as TestStore;
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;

const PLUGIN: &str = "reentry";
const OPERATION: &str = "plugin.reentry.work";

#[derive(Clone, Copy)]
enum Outcome {
    CleanupFailure,
    Success,
    SuccessAfterCancellation,
}

struct Invocation {
    outcome: Outcome,
    entered: Notify,
    release: Semaphore,
    calls: AtomicUsize,
}

impl Invocation {
    async fn started(&self) {
        bounded(self.entered.notified()).await;
        assert_eq!(self.calls.load(Ordering::SeqCst), 1);
    }

    fn finish(&self) {
        self.release.add_permits(1);
    }
}

#[derive(Default)]
struct Controlled {
    unresolved: AtomicBool,
    invocations: Mutex<BTreeMap<String, Arc<Invocation>>>,
}

#[async_trait]
impl Executor for Controlled {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: OPERATION.into(),
            title: "清理债务隔离测试".into(),
            execution: None,
            input_schema: json!({"type":"object","required":["invocation"],
                "properties":{"invocation":{"type":"string"}},"additionalProperties":false}),
        }]
    }

    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }

    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        assert_eq!(operation, OPERATION);
        let label = input["invocation"].as_str().unwrap();
        let invocation = self.invocations.lock().unwrap().get(label).unwrap().clone();
        invocation.calls.fetch_add(1, Ordering::SeqCst);
        invocation.entered.notify_one();
        if matches!(invocation.outcome, Outcome::SuccessAfterCancellation) {
            // 故意晚到成功，验证宿主仍拒绝已取消任务的完成资格。
            cancel.cancelled().await;
        } else {
            tokio::select! { biased;
                _ = cancel.cancelled() => return Err(Error::Cancelled),
                permit = invocation.release.acquire() => permit.unwrap().forget(),
            }
        }
        match invocation.outcome {
            Outcome::CleanupFailure => {
                self.unresolved.store(true, Ordering::SeqCst);
                Err(Error::CleanupFailed)
            }
            Outcome::Success | Outcome::SuccessAfterCancellation => Ok(input),
        }
    }
}

struct Catalog(Arc<Controlled>);

#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        assert_eq!(id, PLUGIN);
        Ok(PluginContribution {
            id: id.into(),
            version: "1".into(),
            executor: self.0.clone(),
        })
    }
}

struct Fixture {
    app: Arc<Application>,
    plugins: Arc<PluginService>,
    store: Arc<TestStore>,
    worker: Arc<Controlled>,
    loaded: PluginInfo,
}

impl Fixture {
    async fn new(concurrency: usize) -> Self {
        let store = Arc::new(TestStore::default());
        let worker = Arc::new(Controlled::default());
        let app = Application::new(store.clone(), vec![], concurrency, 8).unwrap();
        let plugins = PluginService::new(
            app.clone(),
            Arc::new(Catalog(worker.clone())),
            Default::default(),
        );
        let loaded = bounded(plugins.load(PLUGIN.into())).await.unwrap();
        Self {
            app,
            plugins,
            store,
            worker,
            loaded,
        }
    }

    fn prepare(&self, label: &str, outcome: Outcome) -> Arc<Invocation> {
        let invocation = Arc::new(Invocation {
            outcome,
            entered: Notify::new(),
            release: Semaphore::new(0),
            calls: AtomicUsize::new(0),
        });
        assert!(
            self.worker
                .invocations
                .lock()
                .unwrap()
                .insert(label.into(), invocation.clone())
                .is_none()
        );
        invocation
    }

    async fn submit(&self, label: &str) -> Job {
        let job = bounded(
            self.app
                .submit_async(OPERATION.into(), json!({"invocation":label})),
        )
        .await
        .expect("历史清理债务不得拒绝独立任务入队");
        assert_eq!(job.status, JobStatus::Queued);
        job
    }

    fn assert_risk_visible(&self) {
        assert!(self.worker.has_unresolved_resources());
        let plugins = self.plugins.list();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].state, PluginState::Loaded);
        assert!(plugins[0].cleanup_failed);
    }

    fn assert_success(&self, id: &str, label: &str) {
        let job = self.store.get(id).unwrap();
        assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error);
        assert_eq!(job.result, Some(json!({"invocation":label})));
        assert!(job.error.is_none());
        assert_eq!(self.store.attempts(id, JobStatus::Succeeded), 1);
        assert_eq!(self.store.attempts(id, JobStatus::Failed), 0);
        assert_eq!(
            self.store
                .events(id, 0)
                .unwrap()
                .into_iter()
                .map(|event| event.status)
                .collect::<Vec<_>>(),
            vec![JobStatus::Queued, JobStatus::Running, JobStatus::Succeeded]
        );
    }

    async fn close(&self) {
        self.plugins.close();
        bounded(self.plugins.wait()).await;
        bounded(self.app.shutdown()).await.unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // 断言失败也释放测试门闩，不遗留阻塞工作；不接触真实进程或设备。
        for invocation in self.worker.invocations.lock().unwrap().values() {
            invocation.finish();
        }
        self.store.release_all();
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("测试工作没有在看门狗内收敛")
}

async fn terminal(app: &Application, id: &str) -> Job {
    bounded(async {
        loop {
            let job = app.get_async(id.into()).await.unwrap();
            if job.status.is_terminal() {
                return job;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
}

fn assert_cleanup_failure(job: &Job) {
    assert_eq!(job.status, JobStatus::Failed);
    assert!(job.result.is_none());
    assert_eq!(
        job.error.as_deref(),
        Some(Error::CleanupFailed.to_string().as_str())
    );
}

async fn failed_history(fixture: &Fixture) -> Job {
    let call = fixture.prepare("old", Outcome::CleanupFailure);
    let job = fixture.submit("old").await;
    call.started().await;
    call.finish();
    let failed = terminal(&fixture.app, &job.id).await;
    assert_cleanup_failure(&failed);
    fixture.assert_risk_visible();
    failed
}

#[tokio::test]
async fn historical_cleanup_failure_keeps_risk_visible_but_next_job_runs_and_commits() {
    let fixture = Fixture::new(1).await;
    let old = failed_history(&fixture).await;
    let next = fixture.prepare("next", Outcome::Success);
    let job = fixture.submit("next").await;
    next.started().await;
    assert_eq!(
        fixture.store.get(&job.id).unwrap().status,
        JobStatus::Running
    );
    fixture.assert_risk_visible();
    next.finish();
    terminal(&fixture.app, &job.id).await;
    fixture.assert_success(&job.id, "next");
    assert_cleanup_failure(&fixture.store.get(&old.id).unwrap());
    assert_eq!(
        fixture.plugins.list()[0].generation,
        fixture.loaded.generation
    );
    fixture.assert_risk_visible();
    fixture.close().await;
}

#[tokio::test]
async fn cleanup_failure_does_not_poison_a_successful_job_already_running() {
    let fixture = Fixture::new(2).await;
    let successful = fixture.prepare("parallel", Outcome::Success);
    let good = fixture.submit("parallel").await;
    successful.started().await;
    let old = failed_history(&fixture).await;
    assert_eq!(
        fixture.store.get(&good.id).unwrap().status,
        JobStatus::Running
    );
    successful.finish();
    terminal(&fixture.app, &good.id).await;
    fixture.assert_success(&good.id, "parallel");
    assert_cleanup_failure(&fixture.store.get(&old.id).unwrap());
    fixture.assert_risk_visible();
    fixture.close().await;
}

#[tokio::test]
async fn queued_job_still_executes_after_another_job_leaves_cleanup_debt() {
    let fixture = Fixture::new(1).await;
    let failing = fixture.prepare("old", Outcome::CleanupFailure);
    let old = fixture.submit("old").await;
    failing.started().await;
    let next = fixture.prepare("queued", Outcome::Success);
    let job = fixture.submit("queued").await;
    assert_eq!(
        fixture.store.get(&job.id).unwrap().status,
        JobStatus::Queued
    );
    assert_eq!(next.calls.load(Ordering::SeqCst), 0);
    failing.finish();
    assert_cleanup_failure(&terminal(&fixture.app, &old.id).await);
    next.started().await;
    fixture.assert_risk_visible();
    next.finish();
    terminal(&fixture.app, &job.id).await;
    fixture.assert_success(&job.id, "queued");
    assert_cleanup_failure(&fixture.store.get(&old.id).unwrap());
    fixture.close().await;
}

#[tokio::test]
async fn drained_plugin_reloads_without_clearing_the_executor_cleanup_flag() {
    let fixture = Fixture::new(1).await;
    let old = failed_history(&fixture).await;
    let draining = fixture.prepare("draining", Outcome::SuccessAfterCancellation);
    let running = fixture.submit("draining").await;
    draining.started().await;
    let unloaded = bounded(fixture.plugins.unload(PLUGIN.into()))
        .await
        .expect("排空后不得仅因历史布尔标记永久阻断卸载");
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert!(unloaded.cleanup_failed);
    assert!(fixture.worker.has_unresolved_resources());
    assert!(fixture.app.operation(OPERATION).is_none());
    let cancelled = fixture.store.get(&running.id).unwrap();
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    assert!(cancelled.result.is_none());
    assert_eq!(fixture.store.attempts(&running.id, JobStatus::Succeeded), 0);
    let loaded = bounded(fixture.plugins.load(PLUGIN.into()))
        .await
        .expect("重载不得要求先清除历史清理标记");
    assert_eq!(loaded.state, PluginState::Loaded);
    assert_ne!(loaded.generation, fixture.loaded.generation);
    let call = fixture.prepare("reloaded", Outcome::Success);
    let job = fixture.submit("reloaded").await;
    call.started().await;
    call.finish();
    terminal(&fixture.app, &job.id).await;
    fixture.assert_success(&job.id, "reloaded");
    fixture.assert_risk_visible();
    assert_cleanup_failure(&fixture.store.get(&old.id).unwrap());
    bounded(fixture.close()).await;
}

#[tokio::test]
async fn independent_admission_does_not_allow_cancelled_late_success_to_commit() {
    let fixture = Fixture::new(1).await;
    let old = failed_history(&fixture).await;
    let call = fixture.prepare("cancelled", Outcome::SuccessAfterCancellation);
    let job = fixture.submit("cancelled").await;
    call.started().await;
    let cancelled = bounded(fixture.app.cancel_async(job.id.clone()))
        .await
        .unwrap();
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    fixture.close().await;
    let persisted = fixture.store.get(&job.id).unwrap();
    assert_eq!(persisted.status, JobStatus::Cancelled);
    assert!(persisted.result.is_none());
    assert_eq!(fixture.store.attempts(&job.id, JobStatus::Succeeded), 0);
    assert_cleanup_failure(&fixture.store.get(&old.id).unwrap());
    fixture.assert_risk_visible();
}

#[tokio::test]
async fn device_discovery_reenters_with_history_but_old_generation_stays_rejected() {
    let provider = device_fixture::Provider::new("history");
    let (app, plugins, devices, identity) = device_fixture::setup(provider.clone()).await;
    provider.blocked.store(true, Ordering::SeqCst);
    provider.fail_cleanup.store(true, Ordering::SeqCst);
    let old = bounded(app.submit_async("plugin.history.discover".into(), json!({})))
        .await
        .unwrap();
    bounded(provider.started.notified()).await;
    bounded(app.cancel_async(old.id.clone())).await.unwrap();
    bounded(async {
        while !provider.has_unresolved_resources() || !plugins.list()[0].cleanup_failed {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_eq!(provider.cleaned.load(Ordering::SeqCst), 1);
    assert_eq!(terminal(&app, &old.id).await.status, JobStatus::Cancelled);
    // 只让下一次调用正常返回，不清除旧调用留下的 unresolved 标志。
    provider.blocked.store(false, Ordering::SeqCst);
    let directory = bounded(devices.refresh(identity.clone()))
        .await
        .expect("独立发现不得被历史清理标记封锁");
    assert_eq!(directory.provider.id, identity.id);
    assert_eq!(directory.provider.generation, identity.generation);
    assert_eq!(directory.devices.len(), 2);
    assert_eq!(
        terminal(&app, &directory.discovery_job_id).await.status,
        JobStatus::Succeeded
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert!(provider.has_unresolved_resources());
    assert!(plugins.list()[0].cleanup_failed);
    let unloaded = bounded(plugins.unload(identity.id.clone())).await.unwrap();
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert!(unloaded.cleanup_failed);
    assert!(devices.directories().is_empty());
    let loaded = bounded(plugins.load(identity.id.clone())).await.unwrap();
    assert_ne!(loaded.generation, identity.generation);
    assert!(matches!(
        bounded(devices.refresh(identity)).await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let current = apk_domain::devices::ProviderInput {
        id: loaded.id,
        generation: loaded.generation,
    };
    let reloaded = bounded(devices.refresh(current.clone())).await.unwrap();
    assert_eq!(reloaded.provider.generation, current.generation);
    assert_eq!(
        terminal(&app, &reloaded.discovery_job_id).await.status,
        JobStatus::Succeeded
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    assert_eq!(terminal(&app, &old.id).await.status, JobStatus::Cancelled);
    assert!(provider.has_unresolved_resources());
    assert!(plugins.list()[0].cleanup_failed);
    plugins.close();
    bounded(plugins.wait()).await;
    bounded(app.shutdown()).await.unwrap();
}

#[tokio::test]
async fn new_performance_session_samples_without_clearing_old_session_cleanup_debt() {
    use performance_fixture::{Fixture, SOURCE_ID, notified, request, wait_plugin, wait_session};

    let fixture = Fixture::new(Arc::new(SqlitePerformance::open(":memory:").unwrap()), 1);
    let loaded = bounded(fixture.plugins.load(SOURCE_ID.into()))
        .await
        .unwrap();
    fixture.source.mode.store(2, Ordering::Release);
    let old = bounded(fixture.service.start(request(30), CancellationToken::new()))
        .await
        .unwrap();
    notified(&fixture.source.entered).await;
    fixture.source.unresolved.store(true, Ordering::Release);
    let paused = bounded(
        fixture
            .service
            .change(old.id.clone(), PerformanceState::Paused),
    )
    .await
    .unwrap();
    assert_eq!(paused.state, PerformanceState::Paused);
    notified(&fixture.source.cleaned).await;
    wait_plugin(&fixture.plugins, |plugin| plugin.cleanup_failed).await;
    // 暂停先于清理错误提交，晚到错误不得覆盖暂停；新尝试也不清除旧告警。
    fixture.source.mode.store(0, Ordering::Release);
    let resumed = bounded(async {
        loop {
            match fixture
                .service
                .change(old.id.clone(), PerformanceState::Running)
                .await
            {
                Ok(session) => break session,
                // cleaned 通知早于 SampleFlight 释放，只等待这一个真实收口窗口。
                Err(Error::Conflict(message)) if message == "性能样本仍在收口" => {
                    tokio::task::yield_now().await;
                }
                outcome => panic!("非终态会话的新恢复尝试不应被历史风险拒绝：{outcome:?}"),
            }
        }
    })
    .await;
    assert_eq!(resumed.state, PerformanceState::Running);
    assert_eq!(resumed.source, old.source);
    let resumed_sample =
        wait_session(&fixture.service, &old.id, |session| session.samples >= 1).await;
    assert_eq!(resumed_sample.state, PerformanceState::Running);
    assert!(resumed_sample.error.is_none());
    assert!(fixture.source.has_unresolved_resources());
    assert!(fixture.plugins.list()[0].cleanup_failed);
    let stopped = bounded(
        fixture
            .service
            .change(old.id.clone(), PerformanceState::Stopped),
    )
    .await
    .unwrap();
    assert_eq!(stopped.state, PerformanceState::Stopped);
    assert!(stopped.samples >= 1);
    assert!(matches!(
        bounded(
            fixture
                .service
                .change(old.id.clone(), PerformanceState::Running)
        )
        .await,
        Err(Error::Conflict(_))
    ));
    let next = bounded(fixture.service.start(request(30), CancellationToken::new()))
        .await
        .expect("独立性能会话不得因旧会话清理失败而封锁");
    assert_ne!(next.id, old.id);
    assert_eq!(next.source.as_ref().unwrap().generation, loaded.generation);
    let sampled = wait_session(&fixture.service, &next.id, |session| session.samples >= 1).await;
    assert_eq!(sampled.state, PerformanceState::Running);
    assert!(sampled.error.is_none());
    let page = bounded(fixture.service.samples(PerformanceSamples {
        session_id: next.id.clone(),
        after: 0,
        limit: 100,
    }))
    .await
    .unwrap();
    assert!(!page.readings.is_empty());
    let history = bounded(fixture.service.get(old.id)).await.unwrap();
    assert_eq!(history.state, stopped.state);
    assert_eq!(history.revision, stopped.revision);
    assert_eq!(history.samples, stopped.samples);
    assert_eq!(history.error, stopped.error);
    assert_eq!(history.source, old.source);
    assert!(fixture.source.has_unresolved_resources());
    assert!(fixture.plugins.list()[0].cleanup_failed);
    let finished = bounded(fixture.service.change(next.id, PerformanceState::Stopped))
        .await
        .unwrap();
    assert_eq!(finished.state, PerformanceState::Stopped);
    assert!(finished.samples >= 1);
    bounded(fixture.close()).await;
    assert_failed_performance_session_stays_terminal().await;
}

async fn assert_failed_performance_session_stays_terminal() {
    use apk_application::performance::PerformanceService;
    use apk_domain::performance::{PerformanceProbe, PerformanceTarget, RawPerformance};
    use performance_fixture::{request, wait_session};

    struct FailOnce(AtomicBool);
    #[async_trait]
    impl PerformanceProbe for FailOnce {
        async fn sample(
            &self,
            _: &PerformanceTarget,
            _: CancellationToken,
        ) -> Result<RawPerformance> {
            if self.0.swap(false, Ordering::SeqCst) {
                return Err(Error::CleanupFailed);
            }
            Ok(serde_json::from_value(json!({
                "captured_at":apk_domain::now(),"pid":123,"process_start_ticks":900,
                "process_ticks":100,"system_ticks":1000,"logical_cpus":2,
                "pss_kib":1024,"rss_kib":2048,
            }))
            .unwrap())
        }
    }

    let service = PerformanceService::new(
        Arc::new(FailOnce(AtomicBool::new(true))),
        Arc::new(SqlitePerformance::open(":memory:").unwrap()),
        2,
    )
    .unwrap();
    let old = bounded(service.start(request(30), CancellationToken::new()))
        .await
        .unwrap();
    let failed = wait_session(&service, &old.id, |session| {
        session.state == PerformanceState::Failed
    })
    .await;
    assert_eq!(failed.samples, 0);
    assert_eq!(
        failed.error.as_deref(),
        Some(Error::CleanupFailed.to_string().as_str())
    );
    assert!(matches!(
        bounded(service.change(old.id.clone(), PerformanceState::Running)).await,
        Err(Error::Conflict(_))
    ));
    let next = bounded(service.start(request(30), CancellationToken::new()))
        .await
        .expect("真实失败的旧会话保持终态，但不封锁新的独立会话");
    assert_ne!(next.id, old.id);
    let sampled = wait_session(&service, &next.id, |session| session.samples >= 1).await;
    assert_eq!(sampled.state, PerformanceState::Running);
    assert!(sampled.error.is_none());
    let history = bounded(service.get(old.id)).await.unwrap();
    assert_eq!(history.state, PerformanceState::Failed);
    assert_eq!(history.revision, failed.revision);
    assert_eq!(history.error, failed.error);
    assert_eq!(history.samples, 0);
    bounded(service.shutdown()).await.unwrap();
}
