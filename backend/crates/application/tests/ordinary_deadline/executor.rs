//! 假执行器只记录真实首 poll 与收到的上下文；不自行实施超时或取消策略。
use apk_domain::{
    Error, ExecutionContext, Executor, Operation, OperationExecution, OperationExecutionSource,
    Result,
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub const MAIN: &str = "plugin.ordinaryprobe.work";
pub const BLOCKER: &str = "plugin.ordinaryprobe.blocker";
pub const ALIAS: &str = "ordinary.legacy";

#[derive(Clone, Debug)]
pub struct Call {
    pub operation: String,
    pub input: Value,
    pub first_poll_at: Instant,
    pub deadline: Option<Instant>,
    pub cancel: CancellationToken,
}

pub struct Probe {
    operations: Vec<Operation>,
    calls: Mutex<Vec<Call>>,
    returned: Mutex<Vec<String>>,
    ended: Mutex<Vec<String>>,
    failed_cleanup: Mutex<BTreeSet<String>>,
    failed_drop: Mutex<BTreeSet<String>>,
    unresolved: AtomicBool,
    released: Mutex<BTreeMap<String, CancellationToken>>,
}

pub fn operation(id: &str, budget: Option<u64>) -> Operation {
    Operation {
        id: id.into(),
        title: "受控普通操作".into(),
        input_schema: json!({
            "type":"object", "required":["label"], "additionalProperties":false,
            "properties":{"label":{"type":"string"}}
        }),
        execution: budget.map(|total_timeout_ms| OperationExecution {
            api_version: 1,
            total_timeout_ms,
            source: OperationExecutionSource::Declared,
        }),
    }
}

pub fn input(label: &str) -> Value {
    json!({"label":label})
}

impl Probe {
    pub fn new(budget: Option<u64>) -> Arc<Self> {
        Arc::new(Self {
            operations: vec![operation(MAIN, budget), operation(BLOCKER, Some(120_000))],
            calls: Mutex::new(Vec::new()),
            returned: Mutex::new(Vec::new()),
            ended: Mutex::new(Vec::new()),
            failed_cleanup: Mutex::new(BTreeSet::new()),
            failed_drop: Mutex::new(BTreeSet::new()),
            unresolved: AtomicBool::new(false),
            released: Mutex::new(BTreeMap::new()),
        })
    }

    fn release_token(&self, label: &str) -> CancellationToken {
        self.released
            .lock()
            .unwrap()
            .entry(label.into())
            .or_default()
            .clone()
    }

    pub fn release(&self, label: &str) {
        self.release_token(label).cancel();
    }

    pub fn release_all(&self) {
        for token in self.released.lock().unwrap().values() {
            token.cancel();
        }
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    pub fn call(&self, label: &str) -> Option<Call> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .find(|call| call.input["label"] == label)
            .cloned()
    }

    pub fn returned(&self, label: &str) -> bool {
        self.returned
            .lock()
            .unwrap()
            .iter()
            .any(|candidate| candidate == label)
    }

    pub fn ended(&self, label: &str) -> bool {
        self.ended
            .lock()
            .unwrap()
            .iter()
            .any(|candidate| candidate == label)
    }

    pub fn fail_on_release(&self, label: &str) {
        self.failed_cleanup.lock().unwrap().insert(label.into());
    }

    pub fn fail_on_drop(&self, label: &str) {
        self.failed_drop.lock().unwrap().insert(label.into());
    }
}

struct CallLifetime<'a> {
    ended: &'a Mutex<Vec<String>>,
    unresolved: &'a AtomicBool,
    armed: bool,
    label: String,
}
impl Drop for CallLifetime<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.unresolved.store(true, Ordering::SeqCst);
        }
        self.ended.lock().unwrap().push(self.label.clone());
    }
}

#[async_trait]
impl Executor for Probe {
    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }
    fn operations(&self) -> Vec<Operation> {
        self.operations.clone()
    }

    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.execute_with_context(operation, input, cancel, ExecutionContext::default())
            .await
    }

    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        let label = input["label"].as_str().unwrap().to_owned();
        let mut lifetime = CallLifetime {
            ended: &self.ended,
            unresolved: &self.unresolved,
            armed: self.failed_drop.lock().unwrap().contains(&label),
            label: label.clone(),
        };
        let release = self.release_token(&label);
        self.calls.lock().unwrap().push(Call {
            operation: operation.into(),
            input: input.clone(),
            first_poll_at: Instant::now(),
            deadline: context.deadline.map(Instant::from_std),
            cancel,
        });
        // 故意不消费取消 token，宿主必须控制整个执行 Future。
        release.cancelled().await;
        lifetime.armed = false;
        self.returned.lock().unwrap().push(label.clone());
        if self.failed_cleanup.lock().unwrap().contains(&label) {
            self.unresolved.store(true, Ordering::SeqCst);
            return Err(Error::CleanupFailed);
        }
        Ok(input)
    }
}
