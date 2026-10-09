use apk_domain::{Error, Executor, Job, JobEvent, JobStatus, JobStore, Operation, Result, now};
use deviceforge_observability::LogContext;
use futures_util::FutureExt;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::Instrument;
mod blocking;
pub mod plugin_lifecycle;
pub mod registration;
mod registry;
struct Active {
    accepting: bool,
    tokens: BTreeMap<String, CancellationToken>,
}
pub struct Application {
    store: Arc<dyn JobStore>,
    registry: registry::Registry,
    active: Arc<Mutex<Active>>,
    storage_workers: Arc<Semaphore>,
    workers: Arc<Semaphore>,
    capacity: usize,
    tracker: TaskTracker,
}

impl Application {
    pub fn new(
        store: Arc<dyn JobStore>,
        executors: Vec<Arc<dyn Executor>>,
        concurrency: usize,
        capacity: usize,
    ) -> Result<Arc<Self>> {
        if concurrency == 0 || capacity < concurrency {
            return Err(Error::Invalid("并发数必须大于零且不超过任务容量".into()));
        }
        let registry = registry::Registry::new(executors)?;
        store.recover()?;
        Ok(Arc::new(Self {
            store,
            registry,
            active: Arc::new(Mutex::new(Active {
                accepting: true,
                tokens: BTreeMap::new(),
            })),
            storage_workers: Arc::new(Semaphore::new(4)),
            workers: Arc::new(Semaphore::new(concurrency)),
            capacity,
            tracker: TaskTracker::new(),
        }))
    }
    pub fn operations(&self) -> Vec<Operation> {
        self.registry.operations().1
    }
    pub fn operations_snapshot(&self) -> (u64, Vec<Operation>) {
        self.registry.operations()
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

    pub fn submit(self: &Arc<Self>, operation: &str, input: Value) -> Result<Job> {
        let registered = self.registry.find(operation)?;
        registered
            .validator
            .validate(&input)
            .map_err(|e| Error::Invalid(format!("操作输入不符合模式：{e}")))?;
        let mut active = self
            .active
            .lock()
            .map_err(|e| Error::Storage(e.to_string()))?;
        if !active.accepting {
            return Err(Error::Conflict("服务正在停止接收任务".into()));
        }
        if !self.registry.current(operation, &registered)? {
            return Err(Error::Conflict("插件贡献已撤销或重载，请重新提交".into()));
        }
        if active.tokens.len() >= self.capacity {
            return Err(Error::Conflict("任务队列已满".into()));
        }
        let job = Job {
            id: uuid::Uuid::new_v4().to_string(),
            operation: operation.into(),
            input,
            status: JobStatus::Queued,
            result: None,
            error: None,
            created_at: now(),
        };
        self.store.create(&job)?;
        let token = registered
            .owner
            .as_ref()
            .map(|owner| owner.cancel.child_token())
            .unwrap_or_default();
        active.tokens.insert(job.id.clone(), token.clone());
        let app = self.clone();
        let executor = registered.executor.clone();
        let queued = job.clone();
        let context = LogContext::current().unwrap_or_default();
        let span =
            tracing::info_span!("任务", log_id = %context.log_id, job_id = %job.id, operation);
        tracing::info!(parent: &span, "任务已排队");
        let future = async move {
            context
                .scope(
                    async move {
                        let result = app.run(&queued, executor, token).await;
                        if let Err(error) = result {
                            tracing::error!(code = error.code(), "任务生命周期处理失败");
                            let _ = app
                                .transition_async(
                                    queued.id.clone(),
                                    JobStatus::Failed,
                                    None,
                                    Some(error.to_string()),
                                )
                                .await;
                        }
                        if let Ok(mut active) = app.active.lock() {
                            active.tokens.remove(&queued.id);
                        }
                    }
                    .instrument(span),
                )
                .await
        };
        if let Some(owner) = &registered.owner {
            self.tracker.spawn(owner.tracker.track_future(future));
        } else {
            self.tracker.spawn(future);
        }
        Ok(job)
    }
    async fn run(
        &self,
        job: &Job,
        executor: Arc<dyn Executor>,
        token: CancellationToken,
    ) -> Result<()> {
        let _permit = tokio::select! {
            biased;
            _ = token.cancelled() => {
                self.transition_async(job.id.clone(), JobStatus::Cancelled, None, None).await?;
                return Ok(());
            },
            permit = self.workers.acquire() => permit.map_err(|e| Error::Dependency(e.to_string()))?,
        };
        let running = self
            .transition_async(job.id.clone(), JobStatus::Running, None, None)
            .await?;
        if running.status.is_terminal() {
            return Ok(());
        }
        if token.is_cancelled() {
            self.transition_async(job.id.clone(), JobStatus::Cancelled, None, None)
                .await?;
            return Ok(());
        }
        tracing::info!("任务开始执行");
        let execution = std::panic::AssertUnwindSafe(async {
            executor
                .execute(&job.operation, job.input.clone(), token.clone())
                .await
        })
        .catch_unwind();
        tokio::pin!(execution);
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => {
                // 给予异步执行器有限清理时间，超时后释放 Future；取消后不接受晚到成功。
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), &mut execution).await;
                Err(Error::Cancelled)
            },
            result = &mut execution => result.unwrap_or_else(|_| Err(Error::Dependency("执行器发生内部异常".into()))),
        };
        let (status, output, error) = match result {
            Ok(value) => (JobStatus::Succeeded, Some(value), None),
            Err(Error::Cancelled) => (JobStatus::Cancelled, None, None),
            Err(error) => {
                tracing::warn!(code = error.code(), "任务执行失败");
                (JobStatus::Failed, None, Some(error.to_string()))
            }
        };
        let terminal = self
            .transition_async(job.id.clone(), status, output, error)
            .await?;
        tracing::info!(status = ?terminal.status, "任务执行已收敛");
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> Result<Job> {
        let active = self
            .active
            .lock()
            .map_err(|e| Error::Storage(e.to_string()))?;
        let job = self.store.get(id)?;
        tracing::info!(job_id = %job.id, "收到任务取消请求");
        if job.status.is_terminal() {
            return Ok(job);
        }
        let cancelled = self
            .store
            .transition(id, JobStatus::Cancelled, None, None)?;
        if let Some(token) = active.tokens.get(id) {
            token.cancel();
        }
        Ok(cancelled)
    }
    pub async fn shutdown(&self) -> Result<()> {
        tracing::info!("任务服务开始停止");
        let active = self.active.clone();
        let failure = self
            .storage(move |store| {
                let mut failure = None;
                let mut active = active.lock().map_err(|e| Error::Storage(e.to_string()))?;
                active.accepting = false;
                for (id, token) in &active.tokens {
                    // 存储失败也必须释放执行资源，不能提前退出清理。
                    if let Err(error) = store.transition(id, JobStatus::Cancelled, None, None) {
                        failure.get_or_insert(error);
                    }
                    token.cancel();
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
