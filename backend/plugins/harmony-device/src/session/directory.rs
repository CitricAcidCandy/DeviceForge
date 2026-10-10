use super::{Session, files};
use crate::{Error, Result, control::Lease};
use std::{path::PathBuf, sync::atomic::Ordering};
use tokio::time::Instant;

impl Session {
    pub(super) async fn create_directory(&self, scratch: PathBuf) -> Result<PathBuf> {
        let lease = self.control.lease.clone();
        self.work(move |check| {
            check()?;
            files::regular(&scratch, true)?;
            check()?;
            let directory = tempfile::Builder::new()
                .prefix("deviceforge-harmony-device-")
                .tempdir_in(&scratch)
                .map_err(|_| Error::Io("私有工作目录无法创建"))?;
            let path = directory.keep();
            *lease.directory.lock().map_err(|_| Error::CleanupFailed)? = Some(path.clone());
            check()?;
            files::regular(&path, true)?;
            Ok(path)
        })
        .await
    }

    pub(super) async fn cleanup(&self) -> Result<()> {
        let until = self.control.lease.cleanup_point()?;
        let lease = self.control.lease.clone();
        let permit = tokio::time::timeout_at(until, lease.slots.clone().acquire_owned())
            .await
            .map_err(|_| Error::CleanupFailed)?
            .map_err(|_| Error::CleanupFailed)?;
        let mut waiting = crate::control::Waiting::new(
            tokio_util::sync::CancellationToken::new(),
            self.control.unresolved.clone(),
            &self.control.lease,
        );
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            cleanup_paths(&lease, until)
        });
        let joined = tokio::time::timeout_at(until, worker)
            .await
            .map_err(|_| Error::CleanupFailed)?;
        let result = joined.map_err(|_| Error::CleanupFailed)?;
        waiting.confirmed();
        if Instant::now() >= until {
            self.control.unresolved.store(true, Ordering::Release);
            return Err(Error::CleanupFailed);
        }
        if result.is_err() {
            self.control.unresolved.store(true, Ordering::Release);
        }
        result
    }
}

fn cleanup_paths(lease: &Lease, until: Instant) -> Result<()> {
    if Instant::now() >= until {
        return Err(Error::CleanupFailed);
    }
    let Some(path) = lease.directory()? else {
        return Ok(());
    };
    files::regular(&path, true)?;
    if Instant::now() >= until {
        return Err(Error::CleanupFailed);
    }
    std::fs::remove_dir_all(&path).map_err(|_| Error::CleanupFailed)?;
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(Error::CleanupFailed),
    }
    *lease.directory.lock().map_err(|_| Error::CleanupFailed)? = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn expired_cleanup_keeps_directory_and_record() {
        let lease = Lease::default();
        let root = tempfile::tempdir().unwrap();
        *lease.directory.lock().unwrap() = Some(root.path().to_path_buf());
        assert!(matches!(
            cleanup_paths(&lease, Instant::now() - Duration::from_secs(1)),
            Err(Error::CleanupFailed)
        ));
        assert!(root.path().exists());
    }

    #[test]
    fn cleanup_confirms_missing_directory_only_after_actual_delete() {
        let lease = Lease::default();
        let root = tempfile::tempdir().unwrap().keep();
        *lease.directory.lock().unwrap() = Some(root.clone());
        cleanup_paths(&lease, Instant::now() + Duration::from_secs(2)).unwrap();
        assert!(lease.directory().unwrap().is_none());
        assert_eq!(
            std::fs::symlink_metadata(root).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
    }
}
