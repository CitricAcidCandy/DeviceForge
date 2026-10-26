//! 一次安装的编排边界：先检测、兼容零下载、只自动准备缺失必需项。
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Store {
    scanned: PluginDependencies,
    scans: AtomicUsize,
    installs: AtomicUsize,
}

fn target() -> DependencyTarget {
    DependencyTarget {
        kind: DependencyTargetKind::Server,
        id: "third-party".into(),
    }
}

fn view(required: bool, ready: bool, installable: bool) -> PluginDependencies {
    PluginDependencies {
        target: target(),
        revision: "a".repeat(64),
        ready: ready || !required,
        dependencies: vec![DependencyView {
            id: "unregistered-runtime".into(),
            name: "第三方运行时".into(),
            version_requirement: "^1.0".into(),
            required,
            status: if ready {
                DependencyStatus::Ready
            } else {
                DependencyStatus::Missing
            },
            source: ready.then_some(DependencyOrigin::Shared),
            version: ready.then(|| "1.0.0".into()),
            installable,
            message: None,
        }],
    }
}

#[async_trait]
impl DependencyStore for Store {
    async fn get(&self, _: DependencyTarget) -> Result<PluginDependencies> {
        Ok(self.scanned.clone())
    }
    async fn scan(
        &self,
        _: DependencyRequest,
        cancel: CancellationToken,
        _: ExecutionContext,
        _: Arc<dyn ProgressReporter>,
    ) -> Result<PluginDependencies> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        self.scans.fetch_add(1, Ordering::SeqCst);
        Ok(self.scanned.clone())
    }
    async fn install(
        &self,
        _: DependencyRequest,
        _: CancellationToken,
        _: ExecutionContext,
        _: Arc<dyn ProgressReporter>,
    ) -> Result<PluginDependencies> {
        assert!(self.scans.load(Ordering::SeqCst) > 0);
        self.installs.fetch_add(1, Ordering::SeqCst);
        Ok(view(true, true, true))
    }
    async fn forget(&self, _: DependencyTarget) -> Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn normal_install_detects_before_only_missing_required_downloads() {
    for (required, ready, installable, downloads) in [
        (true, true, true, 0),
        (true, false, true, 1),
        (false, false, true, 0),
        (true, false, false, 0),
    ] {
        let store = Arc::new(Store {
            scanned: view(required, ready, installable),
            scans: AtomicUsize::new(0),
            installs: AtomicUsize::new(0),
        });
        let service = DependencyService::new(store.clone());
        let result = service
            .ensure(
                target(),
                CancellationToken::new(),
                Default::default(),
                Arc::new(apk_domain::NoProgress),
            )
            .await
            .unwrap();
        assert_eq!(store.scans.load(Ordering::SeqCst), 1);
        assert_eq!(store.installs.load(Ordering::SeqCst), downloads);
        assert_eq!(result.ready, ready || !required || downloads == 1);
    }
}

#[tokio::test]
async fn rescan_never_downloads_and_cancel_never_starts_install() {
    let store = Arc::new(Store {
        scanned: view(true, false, true),
        scans: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
    });
    let service = DependencyService::new(store.clone());
    let result = service
        .scan(
            DependencyRequest {
                target: target(),
                expected_revision: "a".repeat(64),
                dependency_ids: Vec::new(),
            },
            CancellationToken::new(),
            Default::default(),
            Arc::new(apk_domain::NoProgress),
        )
        .await
        .unwrap();
    assert!(!result.ready);
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        service
            .ensure(
                target(),
                cancel,
                Default::default(),
                Arc::new(apk_domain::NoProgress)
            )
            .await,
        Err(Error::Cancelled)
    ));
    assert_eq!(store.installs.load(Ordering::SeqCst), 0);
}
