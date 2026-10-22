//! 统一插件安装适配器；获取、校验、文件事务和查询各自独立。
mod archive;
mod content;
mod fetch;
mod paths;
mod prepare;
mod storage;
#[cfg(test)]
mod tests;
mod transaction;
use apk_domain::{Error, Result, artifacts::ArtifactStore, plugin_installations::*};
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
    workers: Arc<Semaphore>,
    installations: Arc<Semaphore>,
    readers: Arc<Semaphore>,
}

impl FilePluginInstallations {
    pub async fn open(
        user_root: &Path,
        artifacts: Arc<dyn ArtifactStore>,
        node_binary: Option<PathBuf>,
    ) -> Result<Arc<Self>> {
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
            ] {
                paths::create_directory(&root, child)?;
            }
            let lock = paths::lock(&root.join("installations/.installations.lock"))?;
            transaction::recover(&root)?;
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
            workers: Arc::new(Semaphore::new(2)),
            installations: Arc::new(Semaphore::new(2)),
            readers: Arc::new(Semaphore::new(8)),
        }))
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

struct Stage {
    directory: Option<tempfile::TempDir>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Stage {
    fn path(&self) -> &Path {
        self.directory.as_ref().expect("暂存尚未移交").path()
    }
}
impl Drop for Stage {
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
