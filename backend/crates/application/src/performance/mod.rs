//! 性能会话装配与共享运行状态；生产来源通过宿主弱引用访问当前注册代际。
use crate::{Application, registry::Owner};
use apk_domain::{Error, Result, performance::*};
use source::{SourceAccess, SourceBinding};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
};
use storage::CallContext;
use tokio::{
    sync::{Mutex, Semaphore, watch},
    task::JoinHandle,
    time::Instant,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

enum Source {
    Probe(Arc<dyn PerformanceProbe>),
    Registered(SourceAccess),
}

struct Runtime {
    binding: Option<SourceBinding>,
    deadline: Instant,
    sequence: Arc<Mutex<()>>,
    wake: watch::Sender<u64>,
    cancel: CancellationToken,
    sample_cancel: StdMutex<Option<CancellationToken>>,
    sample_in_flight: AtomicBool,
    unresolved: AtomicBool,
}

impl Runtime {
    fn owner(&self) -> Option<Arc<Owner>> {
        self.binding.as_ref().map(|binding| binding.owner.clone())
    }
    fn source_cancelled(&self) -> bool {
        self.binding
            .as_ref()
            .is_some_and(|binding| binding.owner.cancel.is_cancelled())
    }
    fn cancel_sample(&self) {
        if let Some(cancel) = self
            .sample_cancel
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
        {
            cancel.cancel();
        }
    }
    fn mark_unresolved(&self) {
        self.unresolved.store(true, Ordering::Release);
        if let Some(owner) = self.owner() {
            owner.mark_unresolved();
        }
    }
}

struct Active {
    runtime: Arc<Runtime>,
    handle: Option<JoinHandle<Result<()>>>,
    pending_terminal: Option<PendingTerminal>,
}

#[derive(Clone)]
struct PendingTerminal {
    state: PerformanceState,
    error: Option<String>,
    failure_code: &'static str,
    failure: String,
}
impl PendingTerminal {
    fn failure(&self) -> Error {
        Error::Storage(format!(
            "性能会话终态写入失败 [{}]：{}",
            self.failure_code, self.failure
        ))
    }
}
struct Controls {
    closed: bool,
    active: HashMap<String, Active>,
}
struct Inner {
    source: Source,
    store: Arc<dyn PerformanceStore>,
    capacity: Arc<Semaphore>,
    sample_workers: Arc<Semaphore>,
    storage_workers: Arc<Semaphore>,
    controls: Mutex<Controls>,
    tracker: TaskTracker,
}

#[derive(Clone)]
pub struct PerformanceService(Arc<Inner>);

impl PerformanceService {
    /// 兼容测试替身；生产装配必须使用 registered，不提供平台探针回退。
    pub fn new(
        probe: Arc<dyn PerformanceProbe>,
        store: Arc<dyn PerformanceStore>,
        max_sessions: usize,
    ) -> Result<Self> {
        Self::assemble(Source::Probe(probe), store, max_sessions)
    }
    pub fn registered(
        store: Arc<dyn PerformanceStore>,
        max_sessions: usize,
        default_plugin: Option<String>,
    ) -> Result<Self> {
        Self::assemble(
            Source::Registered(SourceAccess::new(default_plugin)?),
            store,
            max_sessions,
        )
    }
    fn assemble(
        source: Source,
        store: Arc<dyn PerformanceStore>,
        max_sessions: usize,
    ) -> Result<Self> {
        if !(1..=32).contains(&max_sessions) {
            return Err(Error::Invalid("性能并发会话数应为 1–32".into()));
        }
        Ok(Self(Arc::new(Inner {
            source,
            store,
            capacity: Arc::new(Semaphore::new(max_sessions)),
            sample_workers: Arc::new(Semaphore::new(max_sessions)),
            storage_workers: Arc::new(Semaphore::new(4)),
            controls: Mutex::new(Controls {
                closed: false,
                active: HashMap::new(),
            }),
            tracker: TaskTracker::new(),
        })))
    }
    pub fn bind(&self, application: &Arc<Application>) -> Result<()> {
        match &self.0.source {
            Source::Registered(access) => access.bind(application),
            Source::Probe(_) => Err(Error::Conflict("测试性能探针不接受宿主绑定".into())),
        }
    }
    fn capabilities(&self) -> Result<ProbeCapabilities> {
        match &self.0.source {
            Source::Registered(access) => access.capabilities(),
            Source::Probe(probe) => Ok(probe.capabilities()),
        }
    }
}

fn valid_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id).map_err(|_| Error::Invalid("性能会话 ID 必须为 UUID".into()))?;
    Ok(())
}

mod lifecycle;
mod operations;
mod source;
mod storage;
mod worker;
