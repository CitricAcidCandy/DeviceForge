//! 用户目录中的浏览器配置；完整记录原子保存，存储不依赖部署目录。
mod storage;
use apk_domain::{Error, Result, browser_configurations::*, plugins::plugin_id};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct FileBrowserConfigurations {
    root: PathBuf,
    _lock: Arc<fs::File>,
    changes: Arc<Mutex<()>>,
    workers: Arc<Semaphore>,
}

impl FileBrowserConfigurations {
    /// root 由启动装配传入，指向用户配置根下的 browser 子目录。
    pub async fn open(root: &Path) -> Result<Arc<Self>> {
        let root = root.to_owned();
        tokio::task::spawn_blocking(move || {
            let root = storage::open_root(&root)?;
            let lock = storage::lock(&root)?;
            Ok(Arc::new(Self {
                root,
                _lock: Arc::new(lock),
                changes: Arc::new(Mutex::new(())),
                workers: Arc::new(Semaphore::new(2)),
            }))
        })
        .await
        .map_err(|_| Error::Storage("浏览器配置存储初始化异常".into()))?
    }

    async fn work<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Self) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("浏览器配置工作池已满".into()))?;
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            // 许可由阻塞工作持有，调用方取消不提前释放并发名额。
            let _permit = permit;
            let _change = store
                .changes
                .lock()
                .map_err(|_| Error::Storage("浏览器配置状态异常".into()))?;
            storage::check_directory(&store.root)?;
            if fs::canonicalize(&store.root)
                .map_err(|_| Error::Storage("浏览器配置根目录不可访问".into()))?
                != store.root
            {
                return Err(Error::Invalid("浏览器配置根目录越界".into()));
            }
            work(&store)
        })
        .await
        .map_err(|_| Error::Storage("浏览器配置文件工作异常".into()))?
    }
}

#[async_trait::async_trait]
impl BrowserConfigurationStore for FileBrowserConfigurations {
    async fn get(&self, id: &str) -> Result<Option<BrowserConfigurationRecord>> {
        plugin_id(id)?;
        let id = id.to_owned();
        self.work(move |store| storage::read(&store.root, &id))
            .await
    }

    async fn patch(
        &self,
        id: &str,
        expected: Option<String>,
        record: BrowserConfigurationRecord,
    ) -> Result<BrowserConfigurationRecord> {
        plugin_id(id)?;
        if let Some(revision) = &expected {
            validate_browser_revision(revision)?;
        }
        record.validate()?;
        let id = id.to_owned();
        self.work(move |store| {
            let current = storage::read(&store.root, &id)?;
            if current.as_ref().map(|value| value.revision.as_str()) != expected.as_deref() {
                return Err(Error::Conflict(
                    "浏览器配置已被其他页面修改，请刷新后重试".into(),
                ));
            }
            storage::write(&store.root, &id, &record)?;
            Ok(record)
        })
        .await
    }
}

#[cfg(test)]
mod tests;
