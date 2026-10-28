mod config;
mod maintenance;
mod spreadsheet;
mod stream_content;
pub(crate) mod validation;
use apk_domain::artifacts::{
    ArchivePage, Artifact, ArtifactStore, ArtifactStoreConfig, ArtifactStream,
};
use apk_domain::{Error, Result, now};
use async_trait::async_trait;
use futures_util::StreamExt;
pub use maintenance::{MaintenanceReport, MaintenanceWorker};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    fs,
    io::AsyncWriteExt,
    sync::{Mutex, OwnedRwLockReadGuard, OwnedSemaphorePermit, RwLock, Semaphore},
};
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;

const MAX_READERS: usize = 8;
pub struct FileArtifacts {
    root: PathBuf,
    _lock: std::fs::File,
    config: ArtifactStoreConfig,
    quota: Arc<config::Quota>,
    uploads: Arc<Semaphore>,
    readers: Arc<Semaphore>,
    artifact_locks: Arc<Mutex<HashMap<String, Arc<RwLock<()>>>>>,
}
struct Staging(PathBuf);

struct ReadLease {
    _permit: OwnedSemaphorePermit,
    _guard: OwnedRwLockReadGuard<()>,
}
impl Drop for Staging {
    fn drop(&mut self) {
        // 清理仅限本次上传创建的临时目录；取消 Future 时也会执行。
        let path = self.0.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = fs::remove_dir_all(path).await;
            });
        }
    }
}
fn storage(error: impl std::fmt::Display) -> Error {
    Error::Storage(error.to_string())
}
fn valid_id(id: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| Error::Invalid("产物 ID 无效".into()))?;
    if parsed.to_string() != id {
        return Err(Error::Invalid("产物 ID 必须使用规范格式".into()));
    }
    Ok(())
}
pub(crate) fn media_type(filename: &str) -> Result<&'static str> {
    if filename.is_empty()
        || filename.len() > 180
        || filename.starts_with('.')
        || filename.ends_with(['.', ' '])
        || filename
            .chars()
            .any(|c| c.is_control() || "/\\:".contains(c))
    {
        return Err(Error::Invalid(
            "产物名称必须为不含路径的文件名，最多 180 字节".into(),
        ));
    }
    match filename
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "apk" | "apks" | "aab" | "hap" | "zip" => Ok("application/zip"),
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "json" => Ok("application/json"),
        "msgpack" => Ok("application/msgpack"),
        "dex" => Ok("application/vnd.android.dex"),
        "xlsx" => Ok(spreadsheet::XLSX),
        "xls" => Ok(spreadsheet::XLS),
        "csv" => Ok(spreadsheet::CSV),
        "bin" => Ok("application/octet-stream"),
        "js" => Ok("text/javascript"),
        "log" => Ok("text/plain"),
        "md" | "markdown" => Ok("text/markdown"),
        "jsonl" => Ok("application/x-ndjson"),
        "mp4" => Ok("video/mp4"),
        _ => Err(Error::Invalid(
            "仅支持 APK、APKS、AAB、HAP、ZIP、PNG、JPEG、JSON、MSGPACK、DEX、XLSX、XLS、CSV、BIN、JS、LOG、MD、MARKDOWN、JSONL 和 MP4 产物".into(),
        )),
    }
}
impl FileArtifacts {
    pub async fn open(root: impl AsRef<Path>) -> Result<Self> {
        Self::with_config(root, ArtifactStoreConfig::default()).await
    }
    pub async fn with_limit(root: impl AsRef<Path>, max_size: u64) -> Result<Self> {
        Self::with_config(
            root,
            ArtifactStoreConfig {
                max_size,
                ..ArtifactStoreConfig::default()
            },
        )
        .await
    }
    pub async fn with_limits(
        root: impl AsRef<Path>,
        max_size: u64,
        max_total_bytes: u64,
        retention_seconds: Option<u64>,
    ) -> Result<Self> {
        Self::with_config(
            root,
            ArtifactStoreConfig {
                max_size,
                max_total_bytes,
                retention_seconds,
            },
        )
        .await
    }
    pub async fn with_config(root: impl AsRef<Path>, config: ArtifactStoreConfig) -> Result<Self> {
        config.validate()?;
        fs::create_dir_all(root.as_ref()).await.map_err(storage)?;
        let root = fs::canonicalize(root.as_ref()).await.map_err(storage)?;
        let lock_root = root.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(lock_root.join(".lock"))
                .map_err(storage)?;
            file.try_lock()
                .map_err(|_| Error::Conflict("产物目录已由另一个服务实例占用".into()))?;
            Ok::<_, Error>(file)
        })
        .await
        .map_err(storage)??;
        let staging = root.join(".staging");
        fs::create_dir_all(&staging).await.map_err(storage)?;
        if fs::canonicalize(&staging).await.map_err(storage)? != staging {
            return Err(Error::Invalid("临时产物目录不允许链接到其他位置".into()));
        }
        let mut entries = fs::read_dir(&staging).await.map_err(storage)?;
        while let Some(entry) = entries.next_entry().await.map_err(storage)? {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = match entry.file_type().await {
                Ok(file_type) => file_type,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(storage(error)),
            };
            let canonical = match fs::canonicalize(&path).await {
                Ok(canonical) => canonical,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(storage(error)),
            };
            if valid_id(&name).is_ok() && file_type.is_dir() && canonical == path {
                match fs::remove_dir_all(&path).await {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(storage(error)),
                }
            }
        }
        let (confirmed, _) = maintenance::scan_confirmed(&root).await?;
        let committed = confirmed.iter().try_fold(0u64, |total, entry| {
            total
                .checked_add(entry.metadata.size)
                .ok_or(Error::TooLarge)
        })?;
        let max_total_bytes = config.max_total_bytes;
        let has_retention = config.retention_seconds.is_some();
        let store = Self {
            root,
            _lock: lock,
            config,
            quota: config::Quota::new(max_total_bytes, committed)?,
            uploads: Arc::new(Semaphore::new(4)),
            readers: Arc::new(Semaphore::new(MAX_READERS)),
            artifact_locks: Arc::new(Mutex::new(HashMap::new())),
        };
        if has_retention {
            store.maintain().await?;
        }
        Ok(store)
    }
    async fn artifact_lock(&self, id: &str) -> Arc<RwLock<()>> {
        let mut locks = self.artifact_locks.lock().await;
        locks
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(RwLock::new(())))
            .clone()
    }
    pub async fn maintain(&self) -> Result<MaintenanceReport> {
        self.maintain_with_cancel(&CancellationToken::new()).await
    }

    pub async fn maintain_with_cancel(
        &self,
        cancel: &CancellationToken,
    ) -> Result<MaintenanceReport> {
        let (confirmed, skipped_unconfirmed) =
            maintenance::scan_confirmed_with_cancel(&self.root, Some(cancel)).await?;
        let mut report = maintenance::MaintenanceReport {
            scanned: confirmed.len(),
            skipped_unconfirmed,
            ..Default::default()
        };
        let timestamp = now();
        for artifact in confirmed {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if !maintenance::expired(
                artifact.metadata.created_at,
                timestamp,
                self.config.retention_seconds,
            ) {
                continue;
            }
            let lock = self.artifact_lock(&artifact.metadata.id).await;
            let guard = match lock.try_write_owned() {
                Ok(guard) => guard,
                Err(_) => {
                    report.skipped_active += 1;
                    continue;
                }
            };
            if let Err(error) = fs::remove_dir_all(&artifact.directory).await {
                drop(guard);
                if error.kind() == std::io::ErrorKind::NotFound {
                    continue;
                }
                return Err(storage(error));
            }
            self.quota.release_committed(artifact.metadata.size)?;
            drop(guard);
            report.removed += 1;
            report.released_bytes = report
                .released_bytes
                .checked_add(artifact.metadata.size)
                .ok_or(Error::TooLarge)?;
        }
        Ok(report)
    }
    pub async fn cleanup_expired(&self) -> Result<MaintenanceReport> {
        self.maintain().await
    }

    pub fn spawn_retention_worker(
        self: &Arc<Self>,
        shutdown: CancellationToken,
    ) -> Option<MaintenanceWorker> {
        MaintenanceWorker::spawn(Arc::clone(self), self.config.retention_seconds, shutdown)
    }
    async fn directory(&self, id: &str) -> Result<PathBuf> {
        valid_id(id)?;
        let expected = self.root.join(id);
        let actual = fs::canonicalize(&expected).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::NotFound(id.into())
            } else {
                storage(e)
            }
        })?;
        if actual != expected {
            return Err(Error::Invalid("产物目录不允许链接到其他位置".into()));
        }
        Ok(actual)
    }
    async fn content_path(&self, id: &str) -> Result<PathBuf> {
        let directory = self.directory(id).await?;
        let expected = directory.join("content");
        let actual = fs::canonicalize(&expected).await.map_err(storage)?;
        if actual != expected {
            return Err(Error::Invalid("产物内容不允许使用链接".into()));
        }
        Ok(actual)
    }
    async fn verify_content(&self, metadata: &Artifact) -> Result<()> {
        let path = self.content_path(&metadata.id).await?;
        let expected_size = metadata.size;
        let expected_digest = metadata.sha256.clone();
        let (size, digest) = tokio::task::spawn_blocking(move || validation::content_digest(&path))
            .await
            .map_err(storage)??;
        if size != expected_size || digest != expected_digest {
            return Err(Error::Storage("产物内容摘要不匹配".into()));
        }
        Ok(())
    }
    async fn persist(&self, filename: String, mut stream: ArtifactStream) -> Result<Artifact> {
        let media_type = media_type(&filename)?;
        let max_size = match media_type {
            "application/json" | "application/msgpack" => self
                .config
                .max_size
                .min(deviceforge_data_codec::MAX_BYTES as u64),
            "image/jpeg" => self
                .config
                .max_size
                .min(deviceforge_data_codec::jpeg::MAX_BYTES),
            "application/vnd.android.dex" => self.config.max_size.min(validation::DEX_LIMIT),
            value if spreadsheet::is_supported(value) => {
                self.config.max_size.min(spreadsheet::MAX_BYTES)
            }
            _ => self
                .config
                .max_size
                .min(stream_content::limit(media_type).unwrap_or(u64::MAX)),
        };
        let _permit = self
            .uploads
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("并发上传已满".into()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let staging = Staging(self.root.join(".staging").join(&id));
        fs::create_dir(&staging.0).await.map_err(storage)?;
        let path = staging.0.join("content");
        let mut file = fs::File::create(&path).await.map_err(storage)?;
        let mut digest = Sha256::new();
        let mut size = 0u64;
        let mut reservation = self.quota.reserve(0)?;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            let next_size = size
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| Error::Invalid("产物大小溢出".into()))?;
            if next_size > max_size {
                return Err(Error::TooLarge);
            }
            reservation.reserve_more(next_size - size)?;
            size = next_size;
            digest.update(&chunk);
            file.write_all(&chunk).await.map_err(storage)?;
        }
        file.sync_all().await.map_err(storage)?;
        drop(file);
        let validation_path = path.clone();
        // 验证线程持有临时目录和并发许可，取消请求也不会放大后台并发。
        let (staging, _permit) = tokio::task::spawn_blocking(move || {
            validation::validate_content(&validation_path, media_type)?;
            Ok::<_, Error>((staging, _permit))
        })
        .await
        .map_err(storage)??;
        let artifact = Artifact {
            id: id.clone(),
            filename,
            media_type: media_type.into(),
            size,
            sha256: format!("{:x}", digest.finalize()),
            created_at: now(),
        };
        let metadata = serde_json::to_vec(&artifact).map_err(storage)?;
        let mut file = fs::File::create(staging.0.join("metadata.json"))
            .await
            .map_err(storage)?;
        file.write_all(&metadata).await.map_err(storage)?;
        file.sync_all().await.map_err(storage)?;
        drop(file);
        crate::atomic_publish::rename(&staging.0, &self.root.join(id), "调试报告或产物保存")
            .await
            .map_err(storage)?;
        reservation.commit()?;
        Ok(artifact)
    }
}
#[async_trait]
impl ArtifactStore for FileArtifacts {
    async fn put(&self, filename: String, stream: ArtifactStream) -> Result<Artifact> {
        tokio::time::timeout(Duration::from_secs(120), self.persist(filename, stream))
            .await
            .map_err(|_| Error::Timeout)?
    }
    async fn get(&self, id: &str) -> Result<Artifact> {
        let path = self.directory(id).await?.join("metadata.json");
        let info = fs::symlink_metadata(&path).await.map_err(storage)?;
        if info.file_type().is_symlink() || !info.is_file() || info.len() > 4096 {
            return Err(Error::Storage("产物元数据无效".into()));
        }
        let metadata = fs::read(path).await.map_err(storage)?;
        let artifact: Artifact = serde_json::from_slice(&metadata).map_err(storage)?;
        if artifact.id != id || media_type(&artifact.filename)? != artifact.media_type {
            return Err(Error::Storage("产物元数据不匹配".into()));
        }
        self.verify_content(&artifact).await?;
        Ok(artifact)
    }
    async fn delete(&self, id: &str) -> Result<Artifact> {
        let lock = self.artifact_lock(id).await;
        let guard = lock
            .try_write_owned()
            .map_err(|_| Error::Conflict("产物正在被读取或预览".into()))?;
        let metadata = self.get(id).await?;
        let permits = self
            .readers
            .clone()
            .try_acquire_many_owned(MAX_READERS as u32)
            .map_err(|_| Error::Conflict("产物正在被读取或预览".into()))?;
        let directory = self.directory(id).await?;
        fs::remove_dir_all(&directory).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Error::NotFound(id.into())
            } else {
                storage(error)
            }
        })?;
        let release = self.quota.release_committed(metadata.size);
        drop(guard);
        drop(permits);
        release?;
        Ok(metadata)
    }
    async fn download(&self, id: &str) -> Result<(Artifact, ArtifactStream)> {
        let lock = self.artifact_lock(id).await;
        let guard = lock.read_owned().await;
        let permit = self
            .readers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("并发下载已满".into()))?;
        let metadata = self.get(id).await?;
        let file = fs::File::open(self.content_path(id).await?)
            .await
            .map_err(storage)?;
        if file.metadata().await.map_err(storage)?.len() != metadata.size {
            return Err(Error::Storage("产物文件大小不匹配".into()));
        }
        let stream = ReaderStream::with_capacity(file, 64 * 1024);
        let lease = ReadLease {
            _permit: permit,
            _guard: guard,
        };
        let stream = stream.map(move |chunk| {
            let _keep_alive = &lease;
            chunk.map_err(storage)
        });
        Ok((metadata, Box::pin(stream)))
    }
    async fn archive_entries(&self, id: &str, offset: usize, limit: usize) -> Result<ArchivePage> {
        if !(1..=200).contains(&limit) {
            return Err(Error::Invalid("条目页大小必须在 1 到 200 之间".into()));
        }
        if self.get(id).await?.media_type != "application/zip" {
            return Err(Error::Invalid("此产物不是压缩包".into()));
        }
        let lock = self.artifact_lock(id).await;
        let guard = lock.read_owned().await;
        let permit = self
            .readers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("并发预览已满".into()))?;
        let path = self.content_path(id).await?;
        let lease = ReadLease {
            _permit: permit,
            _guard: guard,
        };
        tokio::task::spawn_blocking(move || {
            let _lease = lease;
            validation::entries(&path, offset, limit)
        })
        .await
        .map_err(storage)?
    }
}
