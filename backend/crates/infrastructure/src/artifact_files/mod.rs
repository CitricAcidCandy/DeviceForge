use apk_domain::artifacts::{Artifact, ArtifactStore};
use apk_domain::{Error, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{fs::File, io::AsyncWriteExt};
use tokio_util::sync::CancellationToken;
pub(crate) const LIMIT: u64 = 64 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) struct Temporary(Option<tempfile::TempDir>);
impl Temporary {
    pub(crate) fn new() -> Result<Self> {
        tempfile::tempdir()
            .map(|directory| Self(Some(directory)))
            .map_err(|e| Error::Storage(e.to_string()))
    }
    pub(crate) fn path(&self) -> &std::path::Path {
        self.0.as_ref().expect("临时目录在作用域内存在").path()
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let Some(directory) = self.0.take() else {
            return;
        };
        let path = directory.keep();
        if std::fs::remove_dir_all(&path).is_ok() {
            return;
        }
        // 任务层可能直接丢弃执行 Future；Windows 工具退出后再清理独占临时目录。
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                for _ in 0..100 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if tokio::fs::remove_dir_all(&path).await.is_ok() || !path.exists() {
                        break;
                    }
                }
            });
        }
    }
}

async fn copy_verified(
    store: &dyn ArtifactStore,
    id: &str,
    extensions: &[&str],
    file: &mut File,
) -> Result<Artifact> {
    let (artifact, mut stream) = store.download(id).await?;
    if !extensions
        .iter()
        .any(|extension| artifact.filename.to_ascii_lowercase().ends_with(extension))
    {
        return Err(Error::Invalid(format!(
            "本操作仅支持 {} 产物",
            extensions.join("、")
        )));
    }
    if artifact.size > LIMIT {
        return Err(Error::TooLarge);
    }
    let mut size = 0u64;
    let mut hash = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        size += chunk.len() as u64;
        if size > artifact.size || size > LIMIT {
            return Err(Error::TooLarge);
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| Error::Storage(e.to_string()))?;
    }
    if size != artifact.size || format!("{:x}", hash.finalize()) != artifact.sha256 {
        return Err(Error::Storage("产物大小或 SHA-256 与元数据不一致".into()));
    }
    file.flush()
        .await
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(artifact)
}
pub(crate) struct Materialized {
    pub artifact: Artifact,
    pub path: PathBuf,
    pub directory: Arc<Temporary>,
}
pub(crate) async fn materialize(
    store: &dyn ArtifactStore,
    id: &str,
    extensions: &[&str],
    cancel: CancellationToken,
) -> Result<Materialized> {
    let directory = Arc::new(Temporary::new()?);
    let input = directory.path().join("package.input");
    let mut file = File::create(&input)
        .await
        .map_err(|e| Error::Storage(e.to_string()))?;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::Cancelled),
        value = tokio::time::timeout(TIMEOUT, copy_verified(store, id, extensions, &mut file)) => value.unwrap_or(Err(Error::Timeout)),
    };
    drop(file);
    let artifact = result?;
    let name = artifact.filename.to_ascii_lowercase();
    let extension = extensions
        .iter()
        .find(|extension| name.ends_with(**extension))
        .ok_or_else(|| Error::Invalid("产物扩展名不匹配".into()))?;
    let path = directory.path().join(format!("package{extension}"));
    tokio::fs::rename(input, &path)
        .await
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(Materialized {
        artifact,
        path,
        directory,
    })
}
