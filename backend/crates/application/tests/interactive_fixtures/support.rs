use super::provider::{OPERATION, Provider};
use apk_application::{Application, plugin_lifecycle::PluginService};
use apk_domain::{
    Error, Executor, Operation, Result,
    interactive::{SessionInfo, SessionProvider, SessionStatus},
    plugins::{PluginCatalog, PluginContribution, PluginInfo},
};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct SessionExecutor {
    pub provider: Arc<Provider>,
    pub regular_calls: AtomicUsize,
}

#[async_trait]
impl Executor for SessionExecutor {
    fn operations(&self) -> Vec<Operation> {
        Vec::new()
    }

    fn session_provider(&self) -> Option<Arc<dyn SessionProvider>> {
        Some(self.provider.clone())
    }

    async fn execute(&self, operation: &str, _: Value, _: CancellationToken) -> Result<Value> {
        self.regular_calls.fetch_add(1, Ordering::SeqCst);
        Err(Error::NotFound(operation.into()))
    }
}

struct Catalog {
    executor: Arc<SessionExecutor>,
}

#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        Ok(PluginContribution {
            id: id.into(),
            version: "1".into(),
            executor: self.executor.clone(),
        })
    }
}

pub struct Harness {
    pub app: Arc<Application>,
    pub service: Arc<PluginService>,
    pub provider: Arc<Provider>,
    pub executor: Arc<SessionExecutor>,
}

impl Harness {
    pub fn new(provider: Arc<Provider>) -> Self {
        let executor = Arc::new(SessionExecutor {
            provider: provider.clone(),
            regular_calls: AtomicUsize::new(0),
        });
        let app = Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![],
            1,
            8,
        )
        .unwrap();
        let catalog = Arc::new(Catalog {
            executor: executor.clone(),
        });
        let service = PluginService::new(app.clone(), catalog, HashSet::new());
        Self {
            app,
            service,
            provider,
            executor,
        }
    }

    pub async fn loaded(provider: Arc<Provider>) -> (Self, PluginInfo) {
        let harness = Self::new(provider);
        let loaded = harness.service.load("test".into()).await.unwrap();
        (harness, loaded)
    }

    pub fn open(&self, label: &str) -> SessionInfo {
        self.app
            .open_session(OPERATION, json!({"label":label}))
            .unwrap()
    }

    pub async fn stop(&self) {
        self.service.close();
        self.service.wait().await;
        self.app.shutdown().await.unwrap();
    }
}

pub async fn finished(app: &Application, id: &str) -> SessionInfo {
    status(app, id, SessionStatus::Finished).await
}

pub async fn status(app: &Application, id: &str, expected: SessionStatus) -> SessionInfo {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let info = app.session(id).unwrap();
            if info.status == expected {
                return info;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("交互会话没有在看门狗内收敛")
}

pub async fn output_ready(app: &Application, id: &str, sequence: u64) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if app.session(id).unwrap().output_sequence >= sequence {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("交互输出没有进入宿主缓存")
}
