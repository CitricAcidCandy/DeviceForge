//! 统一插件安装适配器；获取、校验、文件事务和查询各自独立。
mod archive;
mod cleanup;
mod content;
mod fetch;
mod paths;
mod prepare;
mod repository;
mod storage;
#[cfg(test)]
mod tests;
mod transaction;
use apk_domain::{Error, Result, artifacts::ArtifactStore};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

pub struct FilePluginInstallations {
    root: PathBuf,
    handle: std::sync::Weak<Self>,
    _lock: fs::File,
    artifacts: Arc<dyn ArtifactStore>,
    node: Option<PathBuf>,
    client: reqwest::Client,
    changes: Mutex<()>,
    resource_downloads: Arc<tokio::sync::Mutex<()>>,
    workers: Arc<Semaphore>,
    installations: Arc<Semaphore>,
    readers: Arc<Semaphore>,
    trusted_market_sources: Vec<reqwest::Url>,
}

impl FilePluginInstallations {
    pub async fn open(
        user_root: &Path,
        artifacts: Arc<dyn ArtifactStore>,
        node_binary: Option<PathBuf>,
    ) -> Result<Arc<Self>> {
        Self::open_with_sources(user_root, artifacts, node_binary, Vec::new()).await
    }

    pub async fn open_with_sources(
        user_root: &Path,
        artifacts: Arc<dyn ArtifactStore>,
        node_binary: Option<PathBuf>,
        trusted_market_sources: Vec<String>,
    ) -> Result<Arc<Self>> {
        if trusted_market_sources.len() > 128 {
            return Err(Error::TooLarge);
        }
        let trusted_market_sources = trusted_market_sources
            .iter()
            .map(|source| fetch::url(source))
            .collect::<Result<Vec<_>>>()?;
        let root = user_root.to_owned();
        let (root, lock, node) = tokio::task::spawn_blocking(move || {
            let root = paths::open_root(&root)?;
            for child in [
                "plugins",
                "browser-plugins",
                "tools",
                "installations",
                "installations/releases",
                "installations/transactions",
                "installations/staging",
                "installations/resources",
                "installations/identities",
                "installations/manifests",
            ] {
                paths::create_directory(&root, child)?;
            }
            let lock = paths::lock(&root.join("installations/.installations.lock"))?;
            let repository = repository::open(&root)?;
            let writer = repository.write().map_err(repository::error)?;
            transaction::recover(&root)?;
            repository::sync_root(&root, &writer, &[])?;
            paths::clean_staging(&root)?;
            let node = crate::plugin_packages::manifest::node_binary(node_binary)?;
            let node = node.map(|path| paths::external_file(&path)).transpose()?;
            Ok::<_, Error>((root, lock, node))
        })
        .await
        .map_err(|_| Error::Storage("插件安装初始化异常".into()))??;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|_| Error::Dependency("插件下载客户端不可用".into()))?;
        Ok(Arc::new_cyclic(|handle| Self {
            root,
            handle: handle.clone(),
            _lock: lock,
            artifacts,
            node,
            client,
            changes: Mutex::new(()),
            resource_downloads: Arc::new(tokio::sync::Mutex::new(())),
            workers: Arc::new(Semaphore::new(2)),
            installations: Arc::new(Semaphore::new(2)),
            readers: Arc::new(Semaphore::new(8)),
            trusted_market_sources,
        }))
    }

    /// 市场来源是目录根，是否带尾斜线含义一致；匹配时保持目录边界。
    fn validate_market_url(&self, target: &reqwest::Url) -> Result<()> {
        if self.trusted_market_sources.iter().any(|source| {
            let prefix = format!("{}/", source.path().trim_end_matches('/'));
            source.origin() == target.origin() && target.path().starts_with(&prefix)
        }) {
            Ok(())
        } else {
            Err(Error::Invalid("发布 URL 不属于已配置的市场来源".into()))
        }
    }

    async fn work<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Self) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("插件安装文件工作池已满".into()))?;
        let store = self
            .handle
            .upgrade()
            .ok_or_else(|| Error::Conflict("安装存储正在关闭".into()))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _change = store
                .changes
                .lock()
                .map_err(|_| Error::Storage("插件安装事务锁异常".into()))?;
            paths::directory(&store.root)?;
            work(&store)
        })
        .await
        .map_err(|_| Error::Storage("插件安装文件工作异常".into()))?
    }
}

#[derive(Clone)]
struct Stage(Arc<StageLease>);
struct StageLease {
    directory: Option<tempfile::TempDir>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Stage {
    fn path(&self) -> &Path {
        self.0.directory.as_ref().expect("暂存尚未移交").path()
    }

    async fn work<T: Send + 'static>(
        &self,
        store: &FilePluginInstallations,
        work: impl FnOnce(&FilePluginInstallations) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let lease = self.clone();
        store
            .work(move |store| {
                let _lease = lease;
                work(store)
            })
            .await
    }
}
impl Drop for StageLease {
    fn drop(&mut self) {
        let directory = self.directory.take();
        let permit = self.permit.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || {
                drop(directory);
                drop(permit);
            });
        } else {
            drop(directory);
            drop(permit);
        }
    }
}
