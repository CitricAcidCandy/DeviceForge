use apk_domain::{Error, Result, now, performance::*};
use deviceforge_observability::LogContext;
use futures_util::FutureExt;
use std::{collections::HashMap, panic::AssertUnwindSafe, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, Semaphore, watch},
    task::JoinHandle,
    time::{Instant, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;
use tracing::Instrument;

struct Active {
    wake: watch::Sender<u64>,
    cancel: CancellationToken,
    handle: JoinHandle<()>,
}
struct Controls {
    closed: bool,
    active: HashMap<String, Active>,
}
struct Inner {
    probe: Arc<dyn PerformanceProbe>,
    store: Arc<dyn PerformanceStore>,
    capacity: Arc<Semaphore>,
    storage_workers: Arc<Semaphore>,
    controls: Mutex<Controls>,
}
#[derive(Clone)]
pub struct PerformanceService(Arc<Inner>);
impl PerformanceService {
    async fn database<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn PerformanceStore) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .0
            .storage_workers
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Error::Storage("性能存储工作池已关闭".into()))?;
        let store = self.0.store.clone();
        let context = LogContext::current().unwrap_or_default();
        let span = tracing::Span::current();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            context.sync_scope(|| span.in_scope(|| work(store.as_ref())))
        })
        .await
        .map_err(|_| Error::Storage("性能数据库执行异常".into()))?
    }
    /// 启动时应先调用存储 recover；不尝试恢复旧设备采样进程。
    pub fn new(
        probe: Arc<dyn PerformanceProbe>,
        store: Arc<dyn PerformanceStore>,
        max_sessions: usize,
    ) -> Result<Self> {
        if max_sessions == 0 || max_sessions > 32 {
            return Err(Error::Invalid("性能并发会话数应为 1–32".into()));
        }
        Ok(Self(Arc::new(Inner {
            probe,
            store,
            capacity: Arc::new(Semaphore::new(max_sessions)),
            storage_workers: Arc::new(Semaphore::new(4)),
            controls: Mutex::new(Controls {
                closed: false,
                active: HashMap::new(),
            }),
        })))
    }
    pub async fn start(
        &self,
        request: PerformanceStart,
        cancel: CancellationToken,
    ) -> Result<PerformanceSession> {
        let service = self.clone();
        // 启动落库与采样器装配不可因任务 Future 丢弃而只完成一半。
        tokio::spawn(LogContext::propagate(async move {
            service.start_inner(request, cancel).await
        }))
        .await
        .map_err(|_| Error::Dependency("性能会话启动异常".into()))?
    }
    async fn start_inner(
        &self,
        request: PerformanceStart,
        cancel: CancellationToken,
    ) -> Result<PerformanceSession> {
        request.validate()?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let permit = self
            .0
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("性能采样并发会话已满".into()))?;
        let mut controls = self.0.controls.lock().await;
        if controls.closed {
            return Err(Error::Conflict("性能服务正在停止".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let session = PerformanceSession {
            id: id.clone(),
            request: request.clone(),
            state: PerformanceState::Running,
            revision: 0,
            samples: 0,
            started_at: now(),
            updated_at: now(),
            error: None,
        };
        let created = session.clone();
        self.database(move |store| store.create(created)).await?;
        if cancel.is_cancelled() {
            let stopped = id.clone();
            self.database(move |store| {
                store.transition(
                    &stopped,
                    0,
                    PerformanceState::Stopped,
                    Some("启动任务已取消".into()),
                )
            })
            .await?;
            return Err(Error::Cancelled);
        }
        let (wake, receiver) = watch::channel(0);
        let stop = CancellationToken::new();
        let worker_stop = stop.clone();
        let service = self.clone();
        let worker_id = id.clone();
        let span = tracing::info_span!("性能会话", session_id = %id);
        tracing::info!(parent: &span, "性能会话已创建");
        let handle = tokio::spawn(LogContext::propagate(
            async move {
                let _permit = permit;
                let result =
                    AssertUnwindSafe(service.run(&worker_id, request, receiver, worker_stop))
                        .catch_unwind()
                        .await;
                if !matches!(result, Ok(Ok(()))) {
                    tracing::warn!("性能采样会话执行失败");
                    let message = match result {
                        Ok(Err(error)) => error.to_string(),
                        _ => "性能采样执行器异常".into(),
                    };
                    let _ = service
                        .finish(&worker_id, PerformanceState::Failed, Some(message))
                        .await;
                }
                service.0.controls.lock().await.active.remove(&worker_id);
                tracing::info!("性能会话已收敛");
            }
            .instrument(span),
        ));
        controls.active.insert(
            id,
            Active {
                wake,
                cancel: stop,
                handle,
            },
        );
        Ok(session)
    }
    pub async fn get(&self, id: String) -> Result<PerformanceSession> {
        valid_id(&id)?;
        self.database(move |store| store.get(&id)).await
    }
    pub async fn change(&self, id: String, state: PerformanceState) -> Result<PerformanceSession> {
        let service = self.clone();
        tokio::spawn(LogContext::propagate(async move {
            service.change_inner(id, state).await
        }))
        .await
        .map_err(|_| Error::Dependency("性能会话控制异常".into()))?
    }
    async fn change_inner(
        &self,
        id: String,
        state: PerformanceState,
    ) -> Result<PerformanceSession> {
        valid_id(&id)?;
        if !matches!(
            state,
            PerformanceState::Paused | PerformanceState::Running | PerformanceState::Stopped
        ) {
            return Err(Error::Invalid("不支持的性能控制状态".into()));
        }
        let controls = self.0.controls.lock().await;
        let current = self.get(id.clone()).await?;
        if current.state.terminal() {
            return if state == PerformanceState::Stopped {
                Ok(current)
            } else {
                Err(Error::Conflict("性能会话已结束".into()))
            };
        }
        let previous_revision = current.revision;
        let active = controls
            .active
            .get(&id)
            .ok_or_else(|| Error::Conflict("性能会话没有活动采样器".into()))?;
        let updated = self
            .database(move |store| store.transition(&id, current.revision, state, None))
            .await?;
        if updated.revision != previous_revision {
            active.wake.send_replace(updated.revision);
        }
        if state == PerformanceState::Stopped {
            active.cancel.cancel();
        }
        Ok(updated)
    }
    pub async fn samples(&self, request: PerformanceSamples) -> Result<PerformancePage> {
        valid_id(&request.session_id)?;
        self.database(move |store| store.samples(&request.session_id, request.after, request.limit))
            .await
    }
    pub async fn list(&self, request: PerformanceList) -> Result<PerformanceSessions> {
        if let Some(id) = &request.after_id {
            valid_id(id)?;
        }
        self.database(move |store| store.list(request.after_id.as_deref(), request.limit))
            .await
    }
    async fn finish(&self, id: &str, state: PerformanceState, error: Option<String>) -> Result<()> {
        let id = id.to_owned();
        self.database(move |store| {
            loop {
                let current = store.get(&id)?;
                if current.state.terminal() {
                    return Ok(());
                }
                match store.transition(&id, current.revision, state, error.clone()) {
                    Err(Error::Conflict(_)) => continue,
                    result => {
                        result?;
                        return Ok(());
                    }
                }
            }
        })
        .await
    }
    pub async fn shutdown(&self) -> Result<()> {
        let workers = {
            let mut controls = self.0.controls.lock().await;
            controls.closed = true;
            controls
                .active
                .drain()
                .map(|(_, worker)| worker)
                .collect::<Vec<_>>()
        };
        for worker in &workers {
            worker.cancel.cancel();
        }
        let mut failure = None;
        for worker in workers {
            if worker.handle.await.is_err() {
                failure = Some(Error::Dependency("性能会话停止异常".into()));
            }
        }
        failure.map_or(Ok(()), Err)
    }
}
fn valid_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id).map_err(|_| Error::Invalid("性能会话 ID 必须为 UUID".into()))?;
    Ok(())
}
impl PerformanceService {
    async fn run(
        &self,
        id: &str,
        request: PerformanceStart,
        mut wake: watch::Receiver<u64>,
        stop: CancellationToken,
    ) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(u64::from(request.duration_secs));
        let mut interval =
            tokio::time::interval(Duration::from_millis(u64::from(request.interval_ms)));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            if stop.is_cancelled() {
                return self
                    .finish(
                        id,
                        PerformanceState::Interrupted,
                        Some("性能采样器已停止".into()),
                    )
                    .await;
            }
            if Instant::now() >= deadline {
                return self.finish(id, PerformanceState::Completed, None).await;
            }
            let current = self.get(id.to_owned()).await?;
            if current.state.terminal() {
                return Ok(());
            }
            if current.state == PerformanceState::Paused {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => {},
                    _ = tokio::time::sleep_until(deadline) => {},
                    changed = wake.changed() => { if changed.is_err() { return Err(Error::Cancelled); } interval.reset_immediately(); },
                }
                continue;
            }
            tokio::select! {
                biased;
                _ = stop.cancelled() => continue,
                _ = tokio::time::sleep_until(deadline) => continue,
                changed = wake.changed() => { if changed.is_err() { return Err(Error::Cancelled); } continue; },
                _ = interval.tick() => {},
            }
            let revision = current.revision;
            let sample_cancel = CancellationToken::new();
            let sample = tokio::time::timeout(
                Duration::from_secs(10),
                self.0.probe.sample(&request.target, sample_cancel.clone()),
            );
            tokio::pin!(sample);
            let result = tokio::select! {
                biased;
                _ = stop.cancelled() => None,
                _ = tokio::time::sleep_until(deadline) => None,
                _ = wake.changed() => None,
                result = &mut sample => Some(result.unwrap_or(Err(Error::Timeout))),
            };
            let Some(result) = result else {
                sample_cancel.cancel();
                // 给端口短暂清理窗口；不合作的插件端口仍会被丢弃，释放任务容量。
                let _ = tokio::time::timeout(Duration::from_secs(2), &mut sample).await;
                continue;
            };
            let sample_id = id.to_owned();
            match result {
                Ok(raw) => {
                    self.database(move |store| store.append(&sample_id, revision, raw))
                        .await?;
                }
                Err(error) => {
                    let outcome = self
                        .database(move |store| {
                            let latest = store.get(&sample_id)?;
                            if latest.revision != revision
                                || latest.state != PerformanceState::Running
                            {
                                return Ok(false);
                            }
                            match store.transition(
                                &sample_id,
                                revision,
                                PerformanceState::Failed,
                                Some(error.to_string()),
                            ) {
                                Err(Error::Conflict(_)) => Ok(false),
                                result => {
                                    result?;
                                    Ok(true)
                                }
                            }
                        })
                        .await?;
                    if outcome {
                        return Ok(());
                    }
                }
            }
        }
    }
}
mod operations;
