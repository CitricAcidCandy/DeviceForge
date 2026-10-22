//! 有界包暂存、归档校验、同卷发布与公开静态资源读取。
pub(crate) mod archive;
#[cfg(test)]
mod archive_tests;
pub(crate) mod manifest;
mod paths;
mod storage;
#[cfg(test)]
mod storage_tests;
use apk_domain::{Error, Operation, Result, artifacts::ArtifactStream, plugin_packages::*};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) struct Root {
    path: PathBuf,
    _lock: fs::File,
    changes: Mutex<()>,
}
pub struct FilePluginPackages {
    server: Arc<Root>,
    browser: Arc<Root>,
    node: Option<PathBuf>,
    workers: Arc<Semaphore>,
    uploads: Arc<Semaphore>,
    readers: Arc<Semaphore>,
}

impl FilePluginPackages {
    pub async fn open(
        server_root: &Path,
        browser_root: &Path,
        node_binary: Option<PathBuf>,
    ) -> Result<Self> {
        let server = server_root.to_owned();
        let browser = browser_root.to_owned();
        let (server, browser, node) = tokio::task::spawn_blocking(move || {
            fn open_root(path: &Path) -> Result<Arc<Root>> {
                fs::create_dir_all(path)
                    .map_err(|_| Error::Storage("包部署目录创建失败".into()))?;
                let path = fs::canonicalize(path)
                    .map_err(|_| Error::Storage("包部署根不可访问".into()))?;
                let lock = fs::OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(path.join(".packages.lock"))
                    .map_err(|_| Error::Storage("包部署锁不可访问".into()))?;
                lock.try_lock()
                    .map_err(|_| Error::Conflict("包部署目录已由其他安装器占用".into()))?;
                Ok(Arc::new(Root {
                    path,
                    _lock: lock,
                    changes: Mutex::new(()),
                }))
            }
            let server = open_root(&server)?;
            let browser = open_root(&browser)?;
            if server.path.starts_with(&browser.path) || browser.path.starts_with(&server.path) {
                return Err(Error::Invalid("服务器与浏览器部署根必须独立".into()));
            }
            Ok::<_, Error>((server, browser, manifest::node_binary(node_binary)?))
        })
        .await
        .map_err(|_| Error::Storage("包部署初始化异常".into()))??;
        Ok(Self {
            server,
            browser,
            node,
            workers: Arc::new(Semaphore::new(2)),
            uploads: Arc::new(Semaphore::new(2)),
            readers: Arc::new(Semaphore::new(8)),
        })
    }
    fn root(&self, kind: PackageKind) -> Arc<Root> {
        match kind {
            PackageKind::Server => self.server.clone(),
            PackageKind::Browser => self.browser.clone(),
        }
    }
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("包文件工作池已满".into()))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work()
        })
        .await
        .map_err(|_| Error::Storage("包文件工作异常".into()))?
    }
}

struct Staging {
    directory: Option<tempfile::TempDir>,
    upload: Option<OwnedSemaphorePermit>,
}
impl Staging {
    fn path(&self) -> &Path {
        self.directory.as_ref().expect("暂存所有权尚未释放").path()
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        let directory = self.directory.take();
        let upload = self.upload.take();
        // 展开内容的递归清理留在阻塞池，清理完成前继续持有上传许可。
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || {
                drop(directory);
                drop(upload);
            });
        } else {
            drop(directory);
            drop(upload);
        }
    }
}
struct Prepared {
    staging: Staging,
    root: Arc<Root>,
    info: PackageInfo,
    operations: Vec<Operation>,
    workers: Arc<Semaphore>,
}

pub const UPLOAD_LIMIT: u64 = 64 * 1024 * 1024;

// 暂存资源与许可由 Prepared/阻塞工作拥有，丢弃外层 Future 不扩大后台并发。
#[async_trait::async_trait]
impl PackageStore for FilePluginPackages {
    async fn prepare(
        &self,
        kind: PackageKind,
        format: PackageFormat,
        mut stream: ArtifactStream,
    ) -> Result<Box<dyn PreparedPackage>> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let upload = self
            .uploads
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("包上传并发已满".into()))?;
        let root = self.root(kind);
        let temporary_root = root.clone();
        let directory = self
            .blocking(move || {
                tempfile::Builder::new()
                    .prefix(".package-")
                    .tempdir_in(&temporary_root.path)
                    .map_err(|_| Error::Storage("包暂存目录创建失败".into()))
            })
            .await?;
        let staging = Staging {
            directory: Some(directory),
            upload: Some(upload),
        };
        let archive_path = staging.path().join("upload");
        let mut file = tokio::fs::File::create(&archive_path)
            .await
            .map_err(|_| Error::Storage("归档暂存失败".into()))?;
        let mut total = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            total = total
                .checked_add(chunk.len() as u64)
                .ok_or(Error::TooLarge)?;
            if total > UPLOAD_LIMIT {
                return Err(Error::TooLarge);
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| Error::Storage("归档暂存写入失败".into()))?;
        }
        file.flush()
            .await
            .map_err(|_| Error::Storage("归档暂存刷新失败".into()))?;
        drop(file);
        let node = self.node.clone();
        let workers = self.workers.clone();
        self.blocking(move || {
            let content = staging.path().join("content");
            fs::create_dir(&content).map_err(|_| Error::Storage("包展开目录创建失败".into()))?;
            archive::extract(&archive_path, &content, format)?;
            let content = fs::canonicalize(content)
                .map_err(|_| Error::Storage("包展开目录不可访问".into()))?;
            let (info, operations) =
                manifest::validate(&content, &root.path, kind, node.as_deref())?;
            storage::write_info(&content, &info)?;
            Ok(Box::new(Prepared {
                staging,
                root,
                info,
                operations,
                workers,
            }) as Box<dyn PreparedPackage>)
        })
        .await
    }
    async fn list(&self, kind: PackageKind) -> Result<Vec<PackageInfo>> {
        let root = self.root(kind);
        self.blocking(move || storage::list(&root, kind)).await
    }
    async fn delete(&self, kind: PackageKind, id: &str) -> Result<PackageInfo> {
        apk_domain::plugins::plugin_id(id)?;
        let root = self.root(kind);
        let id = id.to_owned();
        self.blocking(move || storage::delete(&root, kind, &id))
            .await
    }
    async fn asset(&self, id: &str, path: &str) -> Result<PackageAsset> {
        storage::asset(self, id, path).await
    }
}

#[async_trait::async_trait]
impl PreparedPackage for Prepared {
    fn info(&self) -> &PackageInfo {
        &self.info
    }
    fn operations(&self) -> &[Operation] {
        &self.operations
    }
    async fn commit(self: Box<Self>) -> Result<PackageInfo> {
        let permit = self
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("包发布工作池已满".into()))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            storage::commit(*self)
        })
        .await
        .map_err(|_| Error::Storage("包发布工作异常".into()))?
    }
    async fn replace(self: Box<Self>) -> Result<PackageInfo> {
        let permit = self
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("包更新工作池已满".into()))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            storage::replace(*self)
        })
        .await
        .map_err(|_| Error::Storage("包更新工作异常".into()))?
    }
}
