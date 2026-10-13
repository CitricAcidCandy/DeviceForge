use apk_domain::{Error, Executor, Job, JobEvent, JobStore, Operation, Result};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
mod alias_plan;
#[cfg(test)]
mod alias_regression;
mod blocking;
mod completion;
pub mod devices;
mod execution;
pub mod interactive;
pub mod operation_aliases;
mod operation_budget;
pub mod plugin_lifecycle;
pub mod plugin_packages;
pub mod registration;
mod registry;
mod registry_aliases;
mod registry_sessions;
mod runner;
mod submission;
mod submission_reservation;
mod terminal;
struct Active {
    accepting: bool,
    tokens: BTreeMap<String, CancellationToken>,
    completions: BTreeMap<String, Arc<completion::Completion>>,
    discoveries: BTreeMap<String, Arc<devices::attempt::Attempt>>,
    creating: BTreeSet<String>,
}
pub struct Application {
    store: Arc<dyn JobStore>,
    registry: registry::Registry,
    active: Arc<Mutex<Active>>,
    storage_workers: Arc<Semaphore>,
    workers: Arc<Semaphore>,
    capacity: usize,
    tracker: TaskTracker,
    device_locks: devices::locks::Locks,
    device_refreshes: Arc<Semaphore>,
    sessions: interactive::Sessions,
}

impl Application {
    pub fn new(
        store: Arc<dyn JobStore>,
        executors: Vec<Arc<dyn Executor>>,
        concurrency: usize,
        capacity: usize,
    ) -> Result<Arc<Self>> {
        Self::new_with_bindings(store, executors, concurrency, capacity, Default::default())
    }

    pub fn new_with_bindings(
        store: Arc<dyn JobStore>,
        executors: Vec<Arc<dyn Executor>>,
        concurrency: usize,
        capacity: usize,
        bindings: operation_aliases::Config,
    ) -> Result<Arc<Self>> {
        if concurrency == 0 || capacity < concurrency {
            return Err(Error::Invalid("并发数必须大于零且不超过任务容量".into()));
        }
        let registry = registry::Registry::new_with_bindings(executors, bindings)?;
        store.recover()?;
        Ok(Arc::new(Self {
            store,
            registry,
            active: Arc::new(Mutex::new(Active {
                accepting: true,
                tokens: BTreeMap::new(),
                completions: BTreeMap::new(),
                discoveries: BTreeMap::new(),
                creating: BTreeSet::new(),
            })),
            storage_workers: Arc::new(Semaphore::new(4)),
            workers: Arc::new(Semaphore::new(concurrency)),
            capacity,
            tracker: TaskTracker::new(),
            device_locks: Default::default(),
            device_refreshes: Arc::new(Semaphore::new(2)),
            sessions: Default::default(),
        }))
    }
    pub fn operations(&self) -> Vec<Operation> {
        self.registry.operations().1
    }
    pub fn operations_snapshot(&self) -> (u64, Vec<Operation>) {
        self.registry.operations()
    }
    pub fn subscribe_contributions(&self) -> tokio::sync::watch::Receiver<u64> {
        self.registry.subscribe()
    }
    pub fn operation(&self, id: &str) -> Option<Operation> {
        self.registry
            .find(id)
            .ok()
            .map(|entry| entry.operation.clone())
    }
    pub fn get(&self, id: &str) -> Result<Job> {
        self.store.get(id)
    }
    pub fn list(&self, limit: usize) -> Result<Vec<Job>> {
        self.store.list(limit)
    }
    pub fn events(&self, id: &str, after: u64) -> Result<Vec<JobEvent>> {
        if after > i64::MAX as u64 {
            return Err(Error::Invalid("事件游标超出支持范围".into()));
        }
        self.store.events(id, after)
    }

    pub(crate) fn request_cancel(&self, id: &str) -> Result<()> {
        self.request_cancel_gate(id).map(|_| ())
    }
    fn request_cancel_gate(&self, id: &str) -> Result<Option<Arc<completion::Completion>>> {
        let (token, attempt, completion) = {
            let active = self
                .active
                .lock()
                .map_err(|e| Error::Storage(e.to_string()))?;
            (
                active.tokens.get(id).cloned(),
                active.discoveries.get(id).cloned(),
                active.completions.get(id).cloned(),
            )
        };
        // Job 成功资格不等于发现目录接受资格，取消必须独立关闭观测门禁。
        if let Some(attempt) = attempt {
            attempt.reject(devices::attempt::Rejection::Cancelled);
        }
        if completion
            .as_ref()
            .map(|completion| completion.request_cancel())
            .transpose()?
            .unwrap_or(true)
            && let Some(token) = token
        {
            token.cancel();
        }
        Ok(completion)
    }
    pub fn cancel(&self, id: &str) -> Result<Job> {
        let completion = self.request_cancel_gate(id)?;
        let job = self.store.get(id)?;
        tracing::info!(job_id = %job.id, "收到任务取消请求");
        if job.status.is_terminal() {
            return Ok(job);
        }
        let token = self
            .active
            .lock()
            .map_err(|_| Error::Storage("取消准入状态异常".into()))?
            .tokens
            .get(id)
            .cloned();
        let cancelled =
            terminal::cancelled(self.store.as_ref(), id, completion.as_ref(), token.as_ref())?;
        Ok(cancelled)
    }
    pub async fn shutdown(&self) -> Result<()> {
        tracing::info!("任务服务开始停止");
        let (tokens, persisted, completions, attempts) = {
            let mut active = self
                .active
                .lock()
                .map_err(|_| Error::Storage("停止准入状态异常".into()))?;
            active.accepting = false;
            (
                active.tokens.clone(),
                active
                    .tokens
                    .iter()
                    .filter(|(id, _)| !active.creating.contains(*id))
                    .map(|(id, token)| (id.clone(), token.clone()))
                    .collect::<BTreeMap<_, _>>(),
                active.completions.clone(),
                active.discoveries.clone(),
            )
        };
        for attempt in attempts.values() {
            attempt.reject(devices::attempt::Rejection::Cancelled);
        }
        self.sessions.cancel_all();
        for (id, token) in &tokens {
            if completions
                .get(id)
                .map(|completion| completion.request_cancel())
                .transpose()?
                .unwrap_or(true)
            {
                if let Some(attempt) = attempts.get(id) {
                    attempt.reject(devices::attempt::Rejection::Cancelled);
                }
                token.cancel();
            }
        }
        let failure = self
            .storage(move |store| {
                let mut failure = None;
                for (id, token) in &persisted {
                    // 存储失败也必须释放执行资源，不能提前退出清理。
                    if let Err(error) =
                        terminal::cancelled(store, id, completions.get(id), Some(token))
                    {
                        failure.get_or_insert(error);
                    }
                }
                Ok(failure)
            })
            .await?;
        self.tracker.close();
        self.tracker.wait().await;
        tracing::info!(success = failure.is_none(), "任务服务已停止");
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

pub mod artifacts;

pub mod packages;

pub mod reverse;

pub mod device_input;

pub mod performance;

pub mod bundles;

pub mod splits;
