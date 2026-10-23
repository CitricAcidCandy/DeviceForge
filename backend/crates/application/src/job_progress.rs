//! 任务进度复用事件存储；写入受共享阻塞池和节流窗口约束。
use crate::Application;
use apk_domain::{Error, JobProgress, JobStage, ProgressReporter, Result};
use async_trait::async_trait;
use std::{
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub(crate) struct JobProgressReporter {
    app: Weak<Application>,
    id: String,
    last: Mutex<Option<(JobStage, Option<String>, Instant)>>,
}
impl JobProgressReporter {
    pub(crate) fn new(app: &Arc<Application>, id: String) -> Arc<Self> {
        Arc::new(Self {
            app: Arc::downgrade(app),
            id,
            last: Mutex::new(None),
        })
    }
}
#[async_trait]
impl ProgressReporter for JobProgressReporter {
    async fn report(&self, progress: JobProgress) -> Result<()> {
        progress.validate()?;
        let mut last = self.last.lock().await;
        if last.as_ref().is_some_and(|(stage, resource, at)| {
            *stage == progress.stage
                && resource == &progress.resource_id
                && at.elapsed() < Duration::from_millis(250)
                && progress.total_bytes != Some(progress.completed_bytes)
        }) {
            return Ok(());
        }
        let app = self.app.upgrade().ok_or_else(|| Error::Cancelled)?;
        let id = self.id.clone();
        let key = (progress.stage, progress.resource_id.clone(), Instant::now());
        app.storage(move |store| store.progress(&id, progress))
            .await?;
        *last = Some(key);
        Ok(())
    }
}
