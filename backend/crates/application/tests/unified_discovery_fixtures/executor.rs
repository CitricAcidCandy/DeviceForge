//! 记录首次业务 poll 的受控执行器；不会声称启动了工具或真实进程。
use apk_domain::{
    Error, ExecutionContext, Executor, ExecutorResultFormat, Operation, Result,
    devices::{CapabilityAccess, CapabilityScope, DeviceCapability, DeviceProviderDefinition},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub fn observed(raw: Option<&str>) -> Value {
    let mut device = json!({
        "id":"same", "state":"unknown", "model":null,
        "capabilities":[{"id":"inspect","version":1,"available":true,"reason":null}],
    });
    if let Some(raw) = raw {
        device["raw_state"] = json!(raw);
    }
    json!([device])
}

pub struct Invocation {
    pub result: Value,
    blocked: bool,
    pub release: Semaphore,
    pub cleanup_release: Semaphore,
    pub cancellation_seen: AtomicBool,
    pub cleaned: AtomicBool,
    pub fail_cleanup: AtomicBool,
}
impl Invocation {
    pub fn ready(result: Value) -> Arc<Self> {
        Self::make(result, false)
    }
    pub fn blocked(result: Value) -> Arc<Self> {
        Self::make(result, true)
    }
    fn make(result: Value, blocked: bool) -> Arc<Self> {
        Arc::new(Self {
            result,
            blocked,
            release: Semaphore::new(0),
            cleanup_release: Semaphore::new(0),
            cancellation_seen: AtomicBool::new(false),
            cleaned: AtomicBool::new(false),
            fail_cleanup: AtomicBool::new(false),
        })
    }
    pub fn finish(&self) {
        self.release.add_permits(1);
    }
    pub fn finish_cleanup(&self) {
        self.cleanup_release.add_permits(1);
    }
}

#[derive(Clone, Debug)]
pub struct Call {
    pub operation: String,
    pub input: Value,
    pub started_at: tokio::time::Instant,
    pub deadline: Option<tokio::time::Instant>,
}
pub struct Provider {
    pub id: String,
    pub api_version: u32,
    pub wrapped: bool,
    pub schema: Mutex<Value>,
    pending: Mutex<Vec<(String, Arc<Invocation>)>>,
    controls: Mutex<Vec<Arc<Invocation>>>,
    calls: Mutex<Vec<Call>>,
    unresolved: AtomicBool,
    pub active: AtomicUsize,
    pub maximum_active: AtomicUsize,
}
impl Provider {
    pub fn new(id: &str, api_version: u32, wrapped: bool) -> Arc<Self> {
        Arc::new(Self {
            id: id.into(),
            api_version,
            wrapped,
            schema: Mutex::new(json!({"type":"object"})),
            pending: Mutex::new(vec![]),
            controls: Mutex::new(vec![]),
            calls: Mutex::new(vec![]),
            unresolved: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            maximum_active: AtomicUsize::new(0),
        })
    }
    pub fn operation(&self) -> String {
        format!("plugin.{}.discover", self.id)
    }
    pub fn blocking_operation(&self) -> String {
        format!("plugin.{}.block", self.id)
    }
    pub fn push(&self, control: Arc<Invocation>) {
        self.push_for(self.operation(), control);
    }
    pub fn push_for(&self, operation: String, control: Arc<Invocation>) {
        self.controls.lock().unwrap().push(control.clone());
        self.pending.lock().unwrap().push((operation, control));
    }
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
    pub fn discovery_calls(&self) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.operation == self.operation())
            .count()
    }
    pub fn release_all(&self) {
        for control in self.controls.lock().unwrap().iter() {
            control.finish();
            control.finish_cleanup();
        }
    }
}
struct ActiveCall<'a>(&'a AtomicUsize);
impl Drop for ActiveCall<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl Executor for Provider {
    fn operations(&self) -> Vec<Operation> {
        vec![
            Operation {
                execution: None,
                id: self.operation(),
                title: "统一发现受控目标".into(),
                input_schema: self.schema.lock().unwrap().clone(),
            },
            Operation {
                execution: None,
                id: format!("plugin.{}.inspect", self.id),
                title: "受控动作".into(),
                input_schema: json!({"type":"object"}),
            },
            Operation {
                execution: None,
                id: self.blocking_operation(),
                title: "工作槽门闩".into(),
                input_schema: json!({"type":"object"}),
            },
        ]
    }
    fn device_provider(&self) -> Option<DeviceProviderDefinition> {
        Some(DeviceProviderDefinition {
            api_version: self.api_version,
            platform: "android".into(),
            discover_operation: self.operation(),
            capabilities: vec![DeviceCapability {
                id: "inspect".into(),
                version: 1,
                operation: format!("plugin.{}.inspect", self.id),
                scope: CapabilityScope::Device,
                access: CapabilityAccess::Read,
                execution_timeout_ms: if self.api_version >= 2 {
                    Some(120_000)
                } else {
                    None
                },
            }],
        })
    }
    fn result_format(&self) -> ExecutorResultFormat {
        if self.wrapped {
            ExecutorResultFormat::PublishedArtifacts
        } else {
            ExecutorResultFormat::Json
        }
    }
    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        panic!("统一发现必须传播绝对执行上下文")
    }
    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        let control = {
            let mut pending = self.pending.lock().unwrap();
            match pending.iter().position(|(name, _)| name == operation) {
                Some(index) => pending.remove(index).1,
                None => Invocation::ready(observed(if self.api_version == 3 {
                    Some("recovery")
                } else {
                    None
                })),
            }
        };
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum_active.fetch_max(active, Ordering::SeqCst);
        let _active = ActiveCall(&self.active);
        self.calls.lock().unwrap().push(Call {
            operation: operation.into(),
            input,
            started_at: tokio::time::Instant::now(),
            deadline: context.deadline.map(tokio::time::Instant::from_std),
        });
        if control.blocked {
            tokio::select! { biased;
                _ = cancel.cancelled() => {
                    control.cancellation_seen.store(true, Ordering::SeqCst);
                    control.cleanup_release.acquire().await.unwrap().forget();
                    if control.fail_cleanup.load(Ordering::SeqCst) {
                        self.unresolved.store(true, Ordering::SeqCst);
                        return Err(Error::CleanupFailed);
                    }
                    control.cleaned.store(true, Ordering::SeqCst);
                    return Err(Error::Cancelled);
                },
                permit = control.release.acquire() => permit.unwrap().forget(),
            }
        }
        Ok(if self.wrapped && operation == self.operation() {
            json!({"result":control.result,"artifacts":[]})
        } else {
            control.result.clone()
        })
    }
}
