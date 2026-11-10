//! 指南下载及单快照缓存；正文规则和当前版本切换由应用层负责。
mod budget;
mod files;
mod source;

use apk_domain::{Error, Result, plugin_guides::GuideStore};
use async_trait::async_trait;
use std::{path::PathBuf, sync::Arc, time::Instant};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub struct HttpGuideStore {
    root: PathBuf,
    source: reqwest::Url,
    client: reqwest::Client,
    workers: Arc<Semaphore>,
    writers: Arc<Semaphore>,
}

impl HttpGuideStore {
    /// 来源由部署装配决定，普通指南请求不接受任意下载地址或文件路径。
    pub fn new(root: PathBuf, source: &str) -> Result<Self> {
        let source = source::validate(source)?;
        Ok(Self {
            root,
            source,
            client: source::client()?,
            workers: Arc::new(Semaphore::new(2)),
            writers: Arc::new(Semaphore::new(1)),
        })
    }
}

#[async_trait]
impl GuideStore for HttpGuideStore {
    async fn load(&self, deadline: Instant, cancel: CancellationToken) -> Result<Option<Vec<u8>>> {
        files::load(self.root.clone(), self.workers.clone(), deadline, cancel).await
    }

    async fn download(&self, deadline: Instant, cancel: CancellationToken) -> Result<Vec<u8>> {
        let _permit = budget::wait(deadline, &cancel, async {
            self.workers
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| Error::Cancelled)
        })
        .await?;
        source::download(&self.client, self.source.clone(), deadline, cancel).await
    }

    async fn save(
        &self,
        bytes: Vec<u8>,
        deadline: Instant,
        cancel: CancellationToken,
    ) -> Result<()> {
        files::save(
            self.root.clone(),
            bytes,
            self.workers.clone(),
            self.writers.clone(),
            deadline,
            cancel,
        )
        .await
    }
}

#[cfg(test)]
mod tests;
