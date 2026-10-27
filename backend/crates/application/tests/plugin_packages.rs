use apk_application::{
    Application, plugin_lifecycle::PluginService, plugin_packages::PackageService,
};
use apk_domain::{
    Error, Executor, Operation, Result, artifacts::ArtifactStream, plugin_packages::*, plugins::*,
};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

struct ExecutorStub {
    unresolved: AtomicBool,
}
#[async_trait]
impl Executor for ExecutorStub {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            execution: None,
            id: "plugin.test.work".into(),
            title: "测试操作".into(),
            input_schema: json!({"type":"object"}),
        }]
    }
    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::Acquire)
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        Ok(Value::Null)
    }
}
struct Deployment {
    deployed: AtomicBool,
    executor: Arc<ExecutorStub>,
    block_load: bool,
    block_delete: bool,
    load_entered: Notify,
    load_release: Notify,
    delete_entered: Notify,
    delete_release: Notify,
    loads: AtomicUsize,
    deletes: AtomicUsize,
}
#[async_trait]
impl PluginCatalog for Deployment {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        self.load_entered.notify_one();
        if self.block_load {
            self.load_release.notified().await;
        }
        if !self.deployed.load(Ordering::Acquire) {
            return Err(Error::NotFound("部署已删除".into()));
        }
        Ok(PluginContribution {
            id: id.into(),
            version: "1".into(),
            executor: self.executor.clone(),
        })
    }
}
#[async_trait]
impl PackageStore for Deployment {
    async fn prepare(
        &self,
        _: PackageKind,
        _: PackageFormat,
        _: ArtifactStream,
    ) -> Result<Box<dyn PreparedPackage>> {
        Err(Error::Invalid("此夹具只验证删除".into()))
    }
    async fn list(&self, _: PackageKind) -> Result<Vec<PackageInfo>> {
        Ok(vec![])
    }
    async fn delete(&self, kind: PackageKind, id: &str) -> Result<PackageInfo> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        self.delete_entered.notify_one();
        if self.block_delete {
            self.delete_release.notified().await;
        }
        self.deployed.store(false, Ordering::Release);
        Ok(PackageInfo {
            kind,
            id: id.into(),
            version: "1".into(),
            runtime: "native".into(),
            entry_path: "plugin.bin".into(),
            entry_url: None,
            api_version: None,
            installed_at: 0,
        })
    }
    async fn asset(&self, _: &str, _: &str) -> Result<PackageAsset> {
        Err(Error::NotFound("夹具没有浏览器资源".into()))
    }
}
fn setup(
    block_load: bool,
    block_delete: bool,
) -> (
    Arc<Application>,
    Arc<PluginService>,
    Arc<PackageService>,
    Arc<Deployment>,
) {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let deployment = Arc::new(Deployment {
        deployed: AtomicBool::new(true),
        executor: Arc::new(ExecutorStub {
            unresolved: AtomicBool::new(false),
        }),
        block_load,
        block_delete,
        load_entered: Notify::new(),
        load_release: Notify::new(),
        delete_entered: Notify::new(),
        delete_release: Notify::new(),
        loads: AtomicUsize::new(0),
        deletes: AtomicUsize::new(0),
    });
    let plugins = PluginService::new(app.clone(), deployment.clone(), Default::default());
    let packages = PackageService::new(deployment.clone(), plugins.clone());
    (app, plugins, packages, deployment)
}

#[tokio::test]
async fn loaded_owner_blocks_deletion_but_unloaded_cleanup_history_does_not() {
    let (app, plugins, packages, deployment) = setup(false, false);
    plugins.load("test".into()).await.unwrap();
    assert!(matches!(
        packages.delete(PackageKind::Server, "test".into()).await,
        Err(Error::Conflict(_))
    ));
    deployment
        .executor
        .unresolved
        .store(true, Ordering::Release);
    assert!(matches!(
        packages.delete(PackageKind::Server, "test".into()).await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(deployment.deletes.load(Ordering::SeqCst), 0);
    assert!(deployment.deployed.load(Ordering::Acquire));
    let unloaded = plugins.unload("test".into()).await.unwrap();
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert!(unloaded.cleanup_failed);
    assert!(plugins.list().is_empty());
    assert!(app.operations().is_empty());
    let deleted = packages
        .delete(PackageKind::Server, "test".into())
        .await
        .unwrap();
    assert_eq!(deleted.id, "test");
    assert_eq!(deployment.deletes.load(Ordering::SeqCst), 1);
    assert!(!deployment.deployed.load(Ordering::Acquire));
    // 部署删除不能改写旧代的清理告警，也不能让已删除的部署重新加载。
    assert!(unloaded.cleanup_failed);
    assert!(matches!(
        plugins.load("test".into()).await,
        Err(Error::NotFound(_))
    ));
    plugins.close();
    plugins.wait().await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn delete_queued_behind_load_rechecks_owner_under_the_same_change_lock() {
    let (app, plugins, packages, deployment) = setup(true, false);
    let loading = {
        let plugins = plugins.clone();
        tokio::spawn(async move { plugins.load("test".into()).await })
    };
    tokio::time::timeout(Duration::from_secs(2), deployment.load_entered.notified())
        .await
        .unwrap();
    let deleting = {
        let packages = packages.clone();
        tokio::spawn(async move { packages.delete(PackageKind::Server, "test".into()).await })
    };
    tokio::task::yield_now().await;
    assert_eq!(deployment.deletes.load(Ordering::SeqCst), 0);
    deployment.load_release.notify_one();
    loading.await.unwrap().unwrap();
    assert!(matches!(deleting.await.unwrap(), Err(Error::Conflict(_))));
    assert_eq!(deployment.deletes.load(Ordering::SeqCst), 0);
    plugins.unload("test".into()).await.unwrap();
    packages
        .delete(PackageKind::Server, "test".into())
        .await
        .unwrap();
    assert!(!deployment.deployed.load(Ordering::Acquire));
    plugins.close();
    plugins.wait().await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_delete_keeps_change_lock_until_deployment_removal_finishes_before_load() {
    let (app, plugins, packages, deployment) = setup(false, true);
    let deleting = {
        let packages = packages.clone();
        tokio::spawn(async move { packages.delete(PackageKind::Server, "test".into()).await })
    };
    tokio::time::timeout(Duration::from_secs(2), deployment.delete_entered.notified())
        .await
        .unwrap();
    deleting.abort();
    let _ = deleting.await;
    let loading = {
        let plugins = plugins.clone();
        tokio::spawn(async move { plugins.load("test".into()).await })
    };
    tokio::task::yield_now().await;
    assert_eq!(deployment.loads.load(Ordering::SeqCst), 0);
    deployment.delete_release.notify_one();
    assert!(matches!(loading.await.unwrap(), Err(Error::NotFound(_))));
    assert_eq!(deployment.deletes.load(Ordering::SeqCst), 1);
    assert!(!deployment.deployed.load(Ordering::Acquire));
    assert!(plugins.list().is_empty());
    plugins.close();
    plugins.wait().await;
    app.shutdown().await.unwrap();
}
