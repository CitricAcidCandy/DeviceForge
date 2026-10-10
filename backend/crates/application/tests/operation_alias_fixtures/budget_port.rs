//! 纯任务端口记录真实准入传下来的绝对截止点，不冒充 Node 传输证据。
use super::config::{GLOBAL, PROVIDER, binding, config_from};
use apk_application::{Application, plugin_lifecycle::PluginService};
use apk_domain::{
    Error, ExecutionContext, Executor, Operation, Result,
    devices::{CapabilityAccess, CapabilityScope, DeviceCapability, DeviceProviderDefinition},
    plugins::{PluginCatalog, PluginContribution},
};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Call {
    pub operation: String,
    pub input: Value,
    pub started_at: tokio::time::Instant,
    pub deadline: tokio::time::Instant,
}
pub struct Probe {
    api: u32,
    budget: Option<u64>,
    calls: Mutex<Vec<Call>>,
    pub blocker_started: AtomicBool,
    pub release: Semaphore,
}
impl Probe {
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
    pub fn blocking(&self) -> bool {
        self.blocker_started.load(Ordering::SeqCst)
    }
}
#[async_trait]
impl Executor for Probe {
    fn operations(&self) -> Vec<Operation> {
        ["discover", "global", "block"]
            .map(|name| Operation {
                execution: None,
                id: format!("plugin.{PROVIDER}.{name}"),
                title: "别名预算端口".into(),
                input_schema: json!({"type":"object"}),
            })
            .to_vec()
    }
    fn device_provider(&self) -> Option<DeviceProviderDefinition> {
        Some(DeviceProviderDefinition {
            api_version: self.api,
            platform: "synthetic_demo".into(),
            discover_operation: format!("plugin.{PROVIDER}.discover"),
            capabilities: vec![DeviceCapability {
                id: "global".into(),
                version: 1,
                operation: format!("plugin.{PROVIDER}.global"),
                scope: CapabilityScope::Provider,
                access: CapabilityAccess::Write,
                execution_timeout_ms: self.budget,
            }],
        })
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        panic!("别名预算必须使用上下文入口")
    }
    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        if operation.ends_with(".block") {
            self.blocker_started.store(true, Ordering::SeqCst);
            tokio::select! { biased;
                _ = cancel.cancelled() => return Err(Error::Cancelled),
                permit = self.release.acquire() => permit.unwrap().forget(),
            }
            return Ok(json!(true));
        }
        assert!(operation.ends_with(".global"), "纯预算测试不调用发现");
        self.calls.lock().unwrap().push(Call {
            operation: operation.into(),
            input,
            started_at: tokio::time::Instant::now(),
            deadline: tokio::time::Instant::from_std(
                context.deadline.expect("设备别名必须有绝对期限"),
            ),
        });
        cancel.cancelled().await;
        Err(Error::Cancelled)
    }
}
struct Catalog(Arc<Probe>);
#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        if id != PROVIDER {
            return Err(Error::NotFound(id.into()));
        }
        Ok(PluginContribution {
            id: id.into(),
            version: "1".into(),
            executor: self.0.clone(),
        })
    }
}

pub struct BudgetFixture {
    pub app: Arc<Application>,
    pub probe: Arc<Probe>,
    plugins: Arc<PluginService>,
}
impl BudgetFixture {
    pub async fn new(api: u32, budget: Option<u64>) -> Self {
        let probe = Arc::new(Probe {
            api,
            budget,
            calls: Mutex::new(vec![]),
            blocker_started: AtomicBool::new(false),
            release: Semaphore::new(0),
        });
        let mut alias = binding(GLOBAL, "global", false);
        // 本端口没有宿主产物格式；预算用例不测试结果包装投影。
        alias["result"] = json!({"kind":"identity"});
        let app = Application::new_with_bindings(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![],
            1,
            16,
            config_from(vec![alias]),
        )
        .unwrap();
        let plugins = PluginService::new(
            app.clone(),
            Arc::new(Catalog(probe.clone())),
            Default::default(),
        );
        plugins.load(PROVIDER.into()).await.unwrap();
        Self {
            app,
            probe,
            plugins,
        }
    }
    pub async fn shutdown(&self) {
        self.plugins.close();
        self.plugins.wait().await;
        self.app.shutdown().await.unwrap();
    }
}
