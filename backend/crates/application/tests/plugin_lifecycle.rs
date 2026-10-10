use apk_application::{Application, plugin_lifecycle::PluginService};
use apk_domain::{Error, Executor, JobStatus, Operation, Result, plugins::*};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

struct Controlled {
    operations: Vec<Operation>,
    started: Notify,
    cleaned: AtomicBool,
    calls: AtomicUsize,
}
fn executor(names: &[&str]) -> Arc<Controlled> {
    Arc::new(Controlled {
        operations: names
            .iter()
            .map(|id| Operation {
                execution: None,
                id: (*id).into(),
                title: "测试贡献".into(),
                input_schema: json!({"type":"object"}),
            })
            .collect(),
        started: Notify::new(),
        cleaned: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
    })
}
#[async_trait]
impl Executor for Controlled {
    fn operations(&self) -> Vec<Operation> {
        self.operations.clone()
    }
    async fn execute(&self, _: &str, _: Value, cancel: CancellationToken) -> Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        cancel.cancelled().await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        self.cleaned.store(true, Ordering::SeqCst);
        Err(Error::Cancelled)
    }
}
struct Catalog {
    executor: Arc<Controlled>,
    delay: bool,
    entered: Notify,
    release: Notify,
}
#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        self.entered.notify_one();
        if self.delay {
            self.release.notified().await;
        }
        Ok(PluginContribution {
            id: id.into(),
            version: "2".into(),
            executor: self.executor.clone(),
        })
    }
}
fn setup(
    catalog: Arc<Catalog>,
    protected: HashSet<String>,
) -> (Arc<Application>, Arc<PluginService>) {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let service = PluginService::new(app.clone(), catalog, protected);
    (app, service)
}
fn contribution(executor: Arc<Controlled>) -> PluginContribution {
    PluginContribution {
        id: "test".into(),
        version: "1".into(),
        executor,
    }
}

#[tokio::test]
async fn conflicts_and_namespace_errors_publish_no_partial_contribution() {
    let valid = executor(&["plugin.test.work"]);
    let catalog = Arc::new(Catalog {
        executor: valid.clone(),
        delay: false,
        entered: Notify::new(),
        release: Notify::new(),
    });
    let (app, service) = setup(catalog, HashSet::new());
    let invalid = executor(&["plugin.test.good", "another.write"]);
    assert!(matches!(
        service.seed(contribution(invalid)).await,
        Err(Error::Invalid(_))
    ));
    assert!(app.operations().is_empty());
    let loaded = service.seed(contribution(valid)).await.unwrap();
    assert!(matches!(
        service.load("test".into()).await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(service.list()[0].generation, loaded.generation);
    assert_eq!(app.operations().len(), 1);
    service.close();
    service.wait().await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn unload_cancels_running_and_queued_tasks_waits_cleanup_and_reloads_new_generation() {
    let worker = executor(&["plugin.test.work"]);
    let catalog = Arc::new(Catalog {
        executor: worker.clone(),
        delay: false,
        entered: Notify::new(),
        release: Notify::new(),
    });
    let (app, service) = setup(catalog, HashSet::new());
    let first_generation = service
        .seed(contribution(worker.clone()))
        .await
        .unwrap()
        .generation;
    let running = app
        .submit_async("plugin.test.work".into(), json!({}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), worker.started.notified())
        .await
        .unwrap();
    let queued = app
        .submit_async("plugin.test.work".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(
        app.get_async(queued.id.clone()).await.unwrap().status,
        JobStatus::Queued
    );
    let unloaded = service.unload("test".into()).await.unwrap();
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert!(worker.cleaned.load(Ordering::SeqCst));
    assert_eq!(worker.calls.load(Ordering::SeqCst), 1);
    for id in [running.id, queued.id] {
        assert_eq!(
            app.get_async(id).await.unwrap().status,
            JobStatus::Cancelled
        );
    }
    assert!(service.list().is_empty());
    assert!(matches!(
        app.submit_async("plugin.test.work".into(), json!({})).await,
        Err(Error::NotFound(_))
    ));
    let next = service.load("test".into()).await.unwrap();
    assert_ne!(next.generation, first_generation);
    assert_eq!(next.version, "2");
    service.close();
    service.wait().await;
    app.shutdown().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_management_request_keeps_bounded_work_and_shutdown_closes_admission() {
    let worker = executor(&["plugin.test.work"]);
    let catalog = Arc::new(Catalog {
        executor: worker,
        delay: true,
        entered: Notify::new(),
        release: Notify::new(),
    });
    let (app, service) = setup(catalog.clone(), HashSet::new());
    let loading = {
        let service = service.clone();
        tokio::spawn(async move { service.load("test".into()).await })
    };
    tokio::time::timeout(Duration::from_secs(2), catalog.entered.notified())
        .await
        .unwrap();
    let queued = {
        let service = service.clone();
        tokio::spawn(async move { service.load("test".into()).await })
    };
    tokio::task::yield_now().await;
    loading.abort();
    let _ = loading.await;
    assert!(matches!(
        service.load("test".into()).await,
        Err(Error::Conflict(_))
    ));
    catalog.release.notify_one();
    tokio::time::timeout(Duration::from_secs(2), catalog.entered.notified())
        .await
        .unwrap();
    catalog.release.notify_one();
    assert!(matches!(queued.await.unwrap(), Err(Error::Conflict(_))));
    assert_eq!(service.list().len(), 1);
    service.close();
    service.wait().await;
    assert!(matches!(
        service.load("test".into()).await,
        Err(Error::Conflict(_))
    ));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn protected_probe_rejects_unload_and_unsafe_ids_do_not_reach_catalog() {
    let worker = executor(&["plugin.test.work"]);
    let catalog = Arc::new(Catalog {
        executor: worker.clone(),
        delay: false,
        entered: Notify::new(),
        release: Notify::new(),
    });
    let (app, service) = setup(catalog.clone(), ["test".into()].into_iter().collect());
    service.seed(contribution(worker)).await.unwrap();
    assert!(service.list()[0].protected);
    assert!(matches!(
        service.unload("test".into()).await,
        Err(Error::Conflict(_))
    ));
    for id in ["../test", ".", "..", "TEST", "builtin.test", "a/b", "a\\b"] {
        assert!(matches!(
            service.load(id.into()).await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(20), catalog.entered.notified())
            .await
            .is_err()
    );
    assert_eq!(app.operations().len(), 1);
    service.close();
    service.wait().await;
    app.shutdown().await.unwrap();
}
