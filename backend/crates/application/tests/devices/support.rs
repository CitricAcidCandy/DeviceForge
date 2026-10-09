use apk_application::{Application, devices::DeviceService, plugin_lifecycle::PluginService};
use apk_domain::{Error, Executor, Operation, Result, devices::*, plugins::*};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;

pub struct Provider {
    pub id: String,
    pub discovery: Mutex<Value>,
    pub schema: Mutex<Option<Value>>,
    pub blocked: AtomicBool,
    pub unresolved: AtomicBool,
    pub fail_cleanup: AtomicBool,
    pub started: Notify,
    pub cleaned: AtomicUsize,
    pub calls: AtomicUsize,
    pub release: Semaphore,
    pub logs: Mutex<Vec<String>>,
}
impl Provider {
    pub fn new(id: &str) -> Arc<Self> {
        Arc::new(Self {
            id: id.into(),
            discovery: Mutex::new(observed()),
            schema: Mutex::new(None),
            blocked: AtomicBool::new(false),
            unresolved: AtomicBool::new(false),
            fail_cleanup: AtomicBool::new(false),
            started: Notify::new(),
            cleaned: AtomicUsize::new(0),
            calls: AtomicUsize::new(0),
            release: Semaphore::new(0),
            logs: Mutex::new(vec![]),
        })
    }
    pub fn definition(&self) -> DeviceProviderDefinition {
        DeviceProviderDefinition {
            api_version: 1,
            platform: "第三方模拟平台".into(),
            discover_operation: format!("plugin.{}.discover", self.id),
            capabilities: vec![
                self.cap("read", CapabilityScope::Device, CapabilityAccess::Read),
                self.cap("write", CapabilityScope::Device, CapabilityAccess::Write),
                self.cap("global", CapabilityScope::Provider, CapabilityAccess::Write),
            ],
        }
    }
    fn cap(&self, id: &str, scope: CapabilityScope, access: CapabilityAccess) -> DeviceCapability {
        DeviceCapability {
            id: id.into(),
            version: 1,
            operation: format!("plugin.{}.{id}", self.id),
            scope,
            access,
        }
    }
}
pub fn observed() -> Value {
    json!([{"id":"same","state":"online","model":null,"capabilities":[{"id":"read","version":1,"available":true,"reason":null},{"id":"write","version":1,"available":true,"reason":null}]},
        {"id":"other","state":"online","model":null,"capabilities":[{"id":"read","version":1,"available":true,"reason":null},{"id":"write","version":1,"available":true,"reason":null}]}])
}
#[async_trait]
impl Executor for Provider {
    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }
    fn device_provider(&self) -> Option<DeviceProviderDefinition> {
        Some(self.definition())
    }
    fn operations(&self) -> Vec<Operation> {
        ["discover", "read", "write", "global"]
            .into_iter()
            .map(|name| Operation {
                id: format!("plugin.{}.{name}", self.id),
                title: "测试能力".into(),
                input_schema: if name == "write" {
                    self.schema
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or(json!({"type":"object"}))
                } else {
                    json!({"type":"object"})
                },
            })
            .collect()
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(log) = deviceforge_observability::LogContext::current() {
            self.logs.lock().unwrap().push(log.log_id);
        }
        self.started.notify_one();
        if self.blocked.load(Ordering::SeqCst) {
            tokio::select! {biased;
                _=cancel.cancelled()=>{
                    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                    self.cleaned.fetch_add(1,Ordering::SeqCst);
                    if self.fail_cleanup.load(Ordering::SeqCst){self.unresolved.store(true,Ordering::SeqCst);}
                    return Err(Error::Cancelled);
                },
                permit=self.release.acquire()=>permit.unwrap().forget(),
            }
        }
        if operation.ends_with(".discover") {
            Ok(self.discovery.lock().unwrap().clone())
        } else {
            Ok(input)
        }
    }
}
struct Catalog(Arc<Provider>);
#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        Ok(PluginContribution {
            id: id.into(),
            version: "1".into(),
            executor: self.0.clone(),
        })
    }
}
pub async fn setup(
    provider: Arc<Provider>,
) -> (
    Arc<Application>,
    Arc<PluginService>,
    Arc<DeviceService>,
    ProviderInput,
) {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        4,
        32,
    )
    .unwrap();
    let plugins = PluginService::new(
        app.clone(),
        Arc::new(Catalog(provider.clone())),
        Default::default(),
    );
    let info = plugins
        .seed(PluginContribution {
            id: provider.id.clone(),
            version: "1".into(),
            executor: provider,
        })
        .await
        .unwrap();
    let devices = DeviceService::new(app.clone());
    (
        app,
        plugins,
        devices,
        ProviderInput {
            id: info.id,
            generation: info.generation,
        },
    )
}
pub fn action(
    provider: &ProviderInput,
    capability: &str,
    device: Option<&str>,
) -> DeviceActionRequest {
    DeviceActionRequest {
        provider_id: provider.id.clone(),
        generation: provider.generation.clone(),
        device_id: device.map(str::to_owned),
        capability: capability.into(),
        version: 1,
        input: json!({}),
    }
}
