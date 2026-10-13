use super::{media_type, valid_id, validation};
use apk_domain::{Error, Result, artifacts::Artifact};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::fs;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MaintenanceReport {
    pub scanned: usize,
    pub removed: usize,
    pub skipped_active: usize,
    pub skipped_unconfirmed: usize,
    pub released_bytes: u64,
}

pub struct MaintenanceWorker {
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl MaintenanceWorker {
    pub(crate) fn spawn(
        store: Arc<super::FileArtifacts>,
        retention_seconds: Option<u64>,
        shutdown: CancellationToken,
    ) -> Option<Self> {
        let interval = worker_interval(retention_seconds)?;
        let stop = shutdown.child_token();
        let worker_stop = stop.clone();
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await;
            loop {
                tokio::select! {
                    _ = worker_stop.cancelled() => break,
                    _ = ticker.tick() => match store.maintain_with_cancel(&worker_stop).await {
                        Ok(report) if report.removed > 0 => {
                            tracing::info!(removed = report.removed, released_bytes = report.released_bytes, "产物保留期维护已回收过期产物");
                        }
                        Ok(_) => {}
                        Err(Error::Cancelled) => break,
                        Err(error) => tracing::warn!(error = %error, "产物保留期维护失败"),
                    },
                }
            }
        });
        Some(Self {
            stop,
            task: Some(task),
        })
    }

    pub async fn shutdown(mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for MaintenanceWorker {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn worker_interval(retention_seconds: Option<u64>) -> Option<Duration> {
    retention_seconds.map(|seconds| Duration::from_secs(seconds.clamp(1, 60)))
}

#[derive(Debug, Clone)]
pub(crate) struct ConfirmedArtifact {
    pub(crate) metadata: Artifact,
    pub(crate) directory: PathBuf,
}

pub(crate) async fn scan_confirmed(root: &Path) -> Result<(Vec<ConfirmedArtifact>, usize)> {
    scan_confirmed_with_cancel(root, None).await
}

pub(crate) async fn scan_confirmed_with_cancel(
    root: &Path,
    cancel: Option<&CancellationToken>,
) -> Result<(Vec<ConfirmedArtifact>, usize)> {
    let mut entries = fs::read_dir(root)
        .await
        .map_err(|error| Error::Storage(error.to_string()))?;
    let mut confirmed = Vec::new();
    let mut skipped_unconfirmed = 0;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| Error::Storage(error.to_string()))?
    {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancelled);
        }
        let path = entry.path();
        let file_type = entry
            .file_type()
            .await
            .map_err(|error| Error::Storage(error.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".staging" || !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        if valid_id(&name).is_err() {
            skipped_unconfirmed += 1;
            continue;
        }
        match confirmed_artifact(&path, &name).await {
            Ok(Some(artifact)) => confirmed.push(artifact),
            Ok(None) => skipped_unconfirmed += 1,
            Err(error) => return Err(error),
        }
    }
    Ok((confirmed, skipped_unconfirmed))
}

async fn confirmed_artifact(path: &Path, id: &str) -> Result<Option<ConfirmedArtifact>> {
    let canonical = match fs::canonicalize(path).await {
        Ok(value) if value == path => value,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::Storage(error.to_string())),
    };
    let metadata_path = canonical.join("metadata.json");
    let metadata_info = match fs::symlink_metadata(&metadata_path).await {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::Storage(error.to_string())),
    };
    if metadata_info.file_type().is_symlink()
        || !metadata_info.is_file()
        || metadata_info.len() > 4096
    {
        return Ok(None);
    }
    let metadata = match fs::read(&metadata_path).await {
        Ok(value) => match serde_json::from_slice::<Artifact>(&value) {
            Ok(metadata) => metadata,
            Err(_) => return Ok(None),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::Storage(error.to_string())),
    };
    if metadata.id != id
        || media_type(&metadata.filename).ok() != Some(metadata.media_type.as_str())
    {
        return Ok(None);
    }
    let content_path = canonical.join("content");
    let content_info = match fs::symlink_metadata(&content_path).await {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::Storage(error.to_string())),
    };
    if content_info.file_type().is_symlink()
        || !content_info.is_file()
        || content_info.len() != metadata.size
    {
        return Ok(None);
    }
    let digest_path = content_path.clone();
    let expected_size = metadata.size;
    let expected_digest = metadata.sha256.clone();
    let (size, digest) =
        tokio::task::spawn_blocking(move || validation::content_digest(&digest_path))
            .await
            .map_err(|error| Error::Storage(error.to_string()))??;
    if size != expected_size || digest != expected_digest {
        return Ok(None);
    }
    Ok(Some(ConfirmedArtifact {
        metadata,
        directory: canonical,
    }))
}

pub(crate) fn expired(created_at: u64, now: u64, retention_seconds: Option<u64>) -> bool {
    let Some(seconds) = retention_seconds else {
        return false;
    };
    let age_ms = seconds.saturating_mul(1_000);
    created_at < now.saturating_sub(age_ms)
}

#[cfg(test)]
mod worker_tests {
    use super::worker_interval;
    use std::time::Duration;

    #[test]
    fn worker_interval_is_bounded_by_retention_and_one_minute() {
        assert_eq!(worker_interval(None), None);
        assert_eq!(worker_interval(Some(0)), Some(Duration::from_secs(1)));
        assert_eq!(worker_interval(Some(5)), Some(Duration::from_secs(5)));
        assert_eq!(worker_interval(Some(120)), Some(Duration::from_secs(60)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiration_uses_millisecond_cutoff_without_underflow() {
        assert!(!expired(0, 1_000, Some(1)));
        assert!(expired(0, 10_001, Some(10)));
        assert!(!expired(10_000, 10_001, Some(10)));
        assert!(!expired(0, 10, None));
    }
}
