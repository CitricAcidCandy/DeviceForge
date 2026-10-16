use super::*;
use apk_domain::Operation;
use apk_infrastructure::{
    artifacts::FileArtifacts, plugin_catalog::FilePluginCatalog, store::SqliteStore,
};
use async_trait::async_trait;
use std::sync::{
    Condvar, Mutex,
    atomic::{AtomicUsize, Ordering},
};

struct Gate {
    entered: AtomicUsize,
    open: Mutex<bool>,
    wake: Condvar,
}
impl Gate {
    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
struct Pending {
    info: PackageInfo,
    gate: Arc<Gate>,
    commits: Arc<AtomicUsize>,
}
#[async_trait]
impl PreparedPackage for Pending {
    fn info(&self) -> &PackageInfo {
        &self.info
    }
    fn operations(&self) -> &[Operation] {
        self.gate.entered.fetch_add(1, Ordering::SeqCst);
        let mut open = self.gate.open.lock().unwrap();
        while !*open {
            open = self.gate.wake.wait(open).unwrap();
        }
        &[]
    }
    async fn commit(self: Box<Self>) -> Result<PackageInfo> {
        self.commits.fetch_add(1, Ordering::SeqCst);
        Ok(self.info.clone())
    }
    async fn replace(self: Box<Self>) -> Result<PackageInfo> {
        self.commits.fetch_add(1, Ordering::SeqCst);
        Ok(self.info.clone())
    }
}
struct Store {
    gate: Arc<Gate>,
    commits: Arc<AtomicUsize>,
}
#[async_trait]
impl PackageStore for Store {
    async fn prepare(
        &self,
        kind: PackageKind,
        _: PackageFormat,
        _: ArtifactStream,
    ) -> Result<Box<dyn PreparedPackage>> {
        Ok(Box::new(Pending {
            info: PackageInfo {
                kind,
                id: "test".into(),
                version: "1".into(),
                runtime: "browser".into(),
                entry_path: "main.js".into(),
                entry_url: None,
                api_version: Some(2),
                installed_at: 0,
            },
            gate: self.gate.clone(),
            commits: self.commits.clone(),
        }))
    }
    async fn list(&self, _: PackageKind) -> Result<Vec<PackageInfo>> {
        Ok(vec![])
    }
    async fn delete(&self, _: PackageKind, _: &str) -> Result<PackageInfo> {
        Err(Error::NotFound("测试没有部署".into()))
    }
    async fn asset(&self, _: &str, _: &str) -> Result<PackageAsset> {
        Err(Error::NotFound("测试没有资源".into()))
    }
}
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[tokio::test]
async fn expected_market_identity_is_checked_before_publication() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(
        FileArtifacts::open(directory.path().join("artifacts"))
            .await
            .unwrap(),
    );
    tokio::fs::create_dir(directory.path().join("plugins"))
        .await
        .unwrap();
    let catalog = Arc::new(
        FilePluginCatalog::open(&directory.path().join("plugins"), artifacts)
            .await
            .unwrap(),
    );
    let app = crate::Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let plugins = PluginService::new(app.clone(), catalog, Default::default());
    let commits = Arc::new(AtomicUsize::new(0));
    let service = PackageService::new(
        Arc::new(Store {
            gate: Arc::new(Gate {
                entered: AtomicUsize::new(0),
                open: Mutex::new(true),
                wake: Condvar::new(),
            }),
            commits: commits.clone(),
        }),
        plugins.clone(),
    );
    for (id, version) in [("other", "1"), ("test", "2")] {
        assert!(matches!(
            service
                .install_expected(
                    PackageKind::Browser,
                    PackageFormat::Zip,
                    Box::pin(futures_util::stream::empty()),
                    Some(id.into()),
                    Some(version.into()),
                )
                .await,
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            service
                .update(
                    PackageKind::Browser,
                    id.into(),
                    PackageFormat::Zip,
                    Box::pin(futures_util::stream::empty()),
                    Some(version.into()),
                )
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert_eq!(commits.load(Ordering::SeqCst), 0);
    service
        .install_expected(
            PackageKind::Browser,
            PackageFormat::Zip,
            Box::pin(futures_util::stream::empty()),
            Some("test".into()),
            Some("1".into()),
        )
        .await
        .unwrap();
    service
        .update(
            PackageKind::Browser,
            "test".into(),
            PackageFormat::Zip,
            Box::pin(futures_util::stream::empty()),
            Some("1".into()),
        )
        .await
        .unwrap();
    assert_eq!(commits.load(Ordering::SeqCst), 2);
    plugins.close();
    plugins.wait().await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_validation_keeps_both_blocking_slots_until_workers_finish() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(
        FileArtifacts::open(directory.path().join("artifacts"))
            .await
            .unwrap(),
    );
    tokio::fs::create_dir(directory.path().join("plugins"))
        .await
        .unwrap();
    let catalog = Arc::new(
        FilePluginCatalog::open(&directory.path().join("plugins"), artifacts)
            .await
            .unwrap(),
    );
    let app = crate::Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let plugins = PluginService::new(app.clone(), catalog, Default::default());
    let gate = Arc::new(Gate {
        entered: AtomicUsize::new(0),
        open: Mutex::new(false),
        wake: Condvar::new(),
    });
    let _release = Release(gate.clone());
    let commits = Arc::new(AtomicUsize::new(0));
    let service = PackageService::new(
        Arc::new(Store {
            gate: gate.clone(),
            commits: commits.clone(),
        }),
        plugins.clone(),
    );
    let install = |service: Arc<PackageService>| {
        tokio::spawn(async move {
            service
                .install(
                    PackageKind::Browser,
                    PackageFormat::Zip,
                    Box::pin(futures_util::stream::empty()),
                )
                .await
        })
    };
    let first = install(service.clone());
    let second = install(service.clone());
    tokio::time::timeout(Duration::from_secs(2), async {
        while gate.entered.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    first.abort();
    second.abort();
    let _ = first.await;
    let _ = second.await;
    assert_eq!(service.validators.available_permits(), 0);
    assert!(matches!(
        service
            .install(
                PackageKind::Browser,
                PackageFormat::Zip,
                Box::pin(futures_util::stream::empty())
            )
            .await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(gate.entered.load(Ordering::SeqCst), 2);
    assert_eq!(commits.load(Ordering::SeqCst), 0);
    gate.release();
    tokio::time::timeout(Duration::from_secs(2), async {
        while service.validators.available_permits() != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    service
        .install(
            PackageKind::Browser,
            PackageFormat::Zip,
            Box::pin(futures_util::stream::empty()),
        )
        .await
        .unwrap();
    assert_eq!(commits.load(Ordering::SeqCst), 1);
    plugins.close();
    plugins.wait().await;
    app.shutdown().await.unwrap();
}
