pub(crate) mod validation;
use apk_domain::artifacts::{ArchivePage, Artifact, ArtifactStore, ArtifactStream};
use apk_domain::{Error, Result, now};
use async_trait::async_trait;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{fs, io::AsyncWriteExt, sync::Semaphore};
use tokio_util::io::ReaderStream;

const DEFAULT_LIMIT: u64 = 64 * 1024 * 1024;
pub struct FileArtifacts {
    root: PathBuf,
    _lock: std::fs::File,
    max_size: u64,
    uploads: Arc<Semaphore>,
    readers: Arc<Semaphore>,
}
struct Staging(PathBuf);
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
        "json" => Ok("application/json"),
        "msgpack" => Ok("application/msgpack"),
        _ => Err(Error::Invalid(
            "仅支持 APK、APKS、AAB、HAP、ZIP、PNG、JSON 和 MSGPACK 产物".into(),
        )),
    }
}
impl FileArtifacts {
    pub async fn open(root: impl AsRef<Path>) -> Result<Self> {
        Self::with_limit(root, DEFAULT_LIMIT).await
    }
    pub async fn with_limit(root: impl AsRef<Path>, max_size: u64) -> Result<Self> {
        if max_size == 0 {
            return Err(Error::Invalid("产物大小上限必须大于零".into()));
        }
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
            let name = entry.file_name().to_string_lossy().into_owned();
            if valid_id(&name).is_ok()
                && entry.file_type().await.map_err(storage)?.is_dir()
                && fs::canonicalize(entry.path()).await.map_err(storage)? == entry.path()
            {
                fs::remove_dir_all(entry.path()).await.map_err(storage)?;
            }
        }
        Ok(Self {
            root,
            _lock: lock,
            max_size,
            uploads: Arc::new(Semaphore::new(4)),
            readers: Arc::new(Semaphore::new(8)),
        })
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
    async fn persist(&self, filename: String, mut stream: ArtifactStream) -> Result<Artifact> {
        let media_type = media_type(&filename)?;
        let max_size = if matches!(media_type, "application/json" | "application/msgpack") {
            self.max_size.min(deviceforge_data_codec::MAX_BYTES as u64)
        } else {
            self.max_size
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
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            size = size
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| Error::Invalid("产物大小溢出".into()))?;
            if size > max_size {
                return Err(Error::TooLarge);
            }
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
        fs::rename(&staging.0, self.root.join(id))
            .await
            .map_err(storage)?;
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
        Ok(artifact)
    }
    async fn download(&self, id: &str) -> Result<(Artifact, ArtifactStream)> {
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
        let stream = stream.map(move |chunk| {
            let _keep_alive = &permit;
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
        let permit = self
            .readers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("并发预览已满".into()))?;
        let path = self.content_path(id).await?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            validation::entries(&path, offset, limit)
        })
        .await
        .map_err(storage)?
    }
}
