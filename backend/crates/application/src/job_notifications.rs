//! 任务存储的通知薄包装；只在持久化成功后更新内存修订，不扫描数据库。

use apk_domain::{Job, JobEvent, JobProgress, JobStatus, JobStore, Result};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::watch;

pub(crate) struct NotifyingJobStore {
    inner: Arc<dyn JobStore>,
    changed: watch::Sender<u64>,
}

impl NotifyingJobStore {
    pub(crate) fn new(inner: Arc<dyn JobStore>) -> Self {
        let (changed, _) = watch::channel(0);
        Self { inner, changed }
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn committed(&self) {
        // 更新与发布在 watch 的同一临界区内排序，订阅者只需读取最新修订。
        self.changed
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }
}

impl JobStore for NotifyingJobStore {
    fn create(&self, job: &Job) -> Result<()> {
        self.inner.create(job)?;
        self.committed();
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Job> {
        self.inner.get(id)
    }

    fn list(&self, limit: usize) -> Result<Vec<Job>> {
        self.inner.list(limit)
    }

    fn transition(
        &self,
        id: &str,
        status: JobStatus,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<Job> {
        let job = self.inner.transition(id, status, result, error)?;
        self.committed();
        Ok(job)
    }

    fn events(&self, id: &str, after: u64) -> Result<Vec<JobEvent>> {
        self.inner.events(id, after)
    }

    fn recover(&self) -> Result<()> {
        self.inner.recover()?;
        self.committed();
        Ok(())
    }

    fn progress(&self, id: &str, progress: JobProgress) -> Result<()> {
        self.inner.progress(id, progress)?;
        self.committed();
        Ok(())
    }
}
