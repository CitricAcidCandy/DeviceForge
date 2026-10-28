//! 同步领域存储保留可替换端口，所有线上访问经受限阻塞工作池。
use crate::Application;
use apk_domain::{Error, Job, JobEvent, JobStatus, JobStore, Result};
use deviceforge_observability::LogContext;
use serde_json::Value;
use std::sync::Arc;

impl Application {
    pub(crate) async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.blocking_until(None, None, work).await
    }
    pub(crate) async fn blocking_until<T: Send + 'static>(
        &self,
        cancel: Option<CancellationToken>,
        deadline: Option<tokio::time::Instant>,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = tokio::select! { biased;
            _ = crate::devices::locks::deadline(deadline) => return Err(Error::Timeout),
            _ = async { match &cancel { Some(token) => token.cancelled().await, None => std::future::pending().await } } => return Err(Error::Cancelled),
            permit = self.storage_workers.clone().acquire_owned() => permit.map_err(|_| Error::Storage("存储工作池已关闭".into()))?,
        };
        crate::operation_budget::check(deadline, cancel.as_ref())?;
        let span = tracing::Span::current();
        let context = LogContext::current().unwrap_or_default();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            context.sync_scope(|| {
                span.in_scope(|| {
                    crate::operation_budget::check(deadline, cancel.as_ref())?;
                    work()
                })
            })
        })
        .await
        .map_err(|_| Error::Storage("存储工作任务异常".into()))?
    }
    pub(crate) async fn storage<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn JobStore) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let store = self.store.clone();
        self.blocking(move || work(store.as_ref())).await
    }
    pub(crate) async fn transition_async(
        &self,
        id: String,
        status: JobStatus,
        output: Option<Value>,
        error: Option<String>,
    ) -> Result<Job> {
        self.storage(move |store| store.transition(&id, status, output, error))
            .await
    }
    pub async fn get_async(&self, id: String) -> Result<Job> {
        self.storage(move |store| store.get(&id)).await
    }
    pub async fn list_async(&self, limit: usize) -> Result<Vec<Job>> {
        self.storage(move |store| store.list(limit)).await
    }
    pub async fn events_async(&self, id: String, after: u64) -> Result<Vec<JobEvent>> {
        if after > i64::MAX as u64 {
            return Err(Error::Invalid("事件游标超出支持范围".into()));
        }
        self.storage(move |store| store.events(&id, after)).await
    }
    pub async fn submit_async(self: &Arc<Self>, operation: String, input: Value) -> Result<Job> {
        let registered = self.registry.find(&operation)?;
        let submission = self.prepare_submission(input.clone(), registered, None)?;
        let cancel = submission.deadline().map(|_| CancellationToken::new());
        let mut guard = SubmissionCancel(cancel.clone());
        let result = self
            .dispatch_submission(operation, input, submission, cancel)
            .await;
        guard.0.take();
        result.map(|(job, _)| job)
    }
    pub async fn cancel_async(self: &Arc<Self>, id: String) -> Result<Job> {
        // 先关闭发布门禁；存储槽被占用不应延迟取消的生效。
        self.request_cancel(&id)?;
        let app = self.clone();
        self.blocking(move || app.cancel(&id)).await
    }
}

use tokio_util::sync::CancellationToken;
struct SubmissionCancel(Option<CancellationToken>);
impl Drop for SubmissionCancel {
    fn drop(&mut self) {
        if let Some(token) = &self.0 {
            token.cancel();
        }
    }
}

impl Application {
    pub(crate) async fn dispatch_submission(
        self: &Arc<Self>,
        operation: String,
        input: Value,
        submission: crate::submission::Submission,
        external: Option<CancellationToken>,
    ) -> Result<(Job, Option<Arc<crate::devices::attempt::Attempt>>)> {
        let deadline = submission.deadline();
        let task = {
            let active = self
                .active
                .lock()
                .map_err(|_| Error::Storage("提交准入状态异常".into()))?;
            if !active.accepting {
                return Err(Error::Conflict("任务服务正在停止".into()));
            }
            let app = self.clone();
            self.tracker.spawn(LogContext::propagate(async move {
                let submitted_app = app.clone();
                let submitted_cancel = external.clone();
                let work = app.blocking_until(external.clone(), deadline, move || submitted_app.submit_prepared(&operation, input, submission, submitted_cancel));
                tokio::pin!(work);
                let result = tokio::select! { biased;
                    _ = crate::devices::locks::deadline(deadline) => Err(Error::Timeout),
                    _ = async { match &external {Some(token) => token.cancelled().await, None => std::future::pending().await} } => Err(Error::Cancelled),
                    result = &mut work => return result,
                };
                if let Some(cancel) = &external { cancel.cancel(); }
                // 正在执行的阻塞闭包不能遗弃；等待它排空后才释放发现额度。
                let _ = work.await;
                result
            }))
        };
        task.await
            .map_err(|_| Error::Storage("提交后台工作异常".into()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apk_infrastructure::store::SqliteStore;
    use std::{
        sync::{Condvar, Mutex},
        time::Duration,
    };

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_waiters_do_not_release_running_blocking_workers() {
        let app = Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![],
            1,
            8,
        )
        .unwrap();
        let released = Arc::new((Mutex::new(false), Condvar::new()));
        let (started, mut arrivals) = tokio::sync::mpsc::unbounded_channel();
        let mut tasks = Vec::new();
        for _ in 0..12 {
            let app = app.clone();
            let released = released.clone();
            let started = started.clone();
            tasks.push(tokio::spawn(async move {
                app.blocking(move || {
                    started.send(()).unwrap();
                    let (lock, wake) = &*released;
                    let state = lock.lock().unwrap();
                    let _state = wake
                        .wait_timeout_while(state, Duration::from_secs(3), |open| !*open)
                        .unwrap();
                    Ok(())
                })
                .await
            }));
        }
        for _ in 0..4 {
            tokio::time::timeout(Duration::from_secs(2), arrivals.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(app.storage_workers.available_permits(), 0);
        assert!(arrivals.try_recv().is_err());
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
        assert_eq!(app.storage_workers.available_permits(), 0);
        let (lock, wake) = &*released;
        *lock.lock().unwrap() = true;
        wake.notify_all();
        tokio::time::timeout(Duration::from_secs(2), async {
            while app.storage_workers.available_permits() != 4 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(arrivals.try_recv().is_err());
        app.shutdown().await.unwrap();
    }
}
