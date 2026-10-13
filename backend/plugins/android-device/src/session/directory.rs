use super::{Session, files};
use crate::control::Lease;
use crate::{Error, Result};
use std::{path::PathBuf, sync::atomic::Ordering};
use tokio::time::Instant;

impl Session {
    pub(crate) async fn create_directory(&self, scratch: PathBuf) -> Result<PathBuf> {
        let lease = self.control.lease.clone();
        self.work(move |check| {
            check()?;
            files::regular(&scratch, true)?;
            check()?;
            let directory = tempfile::Builder::new()
                .prefix("deviceforge-android-device-")
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

    pub(super) async fn cleanup(&self, failed: bool) -> Result<()> {
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
            cleanup_paths(&lease, until, failed)
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

fn cleanup_paths(lease: &Lease, until: Instant, failed: bool) -> Result<()> {
    if Instant::now() >= until {
        return Err(Error::CleanupFailed);
    }
    if failed {
        let output = lease
            .output
            .lock()
            .map_err(|_| Error::CleanupFailed)?
            .clone();
        if let Some(path) = output {
            files::regular(&path, false)?;
            if Instant::now() >= until {
                return Err(Error::CleanupFailed);
            }
            std::fs::remove_file(&path).map_err(|_| Error::CleanupFailed)?;
            match std::fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(Error::CleanupFailed),
            }
            *lease.output.lock().map_err(|_| Error::CleanupFailed)? = None;
        }
    }
    if failed {
        loop {
            let path = lease.profile_outputs.lock().map_err(|_| Error::CleanupFailed)?.last().cloned();
            let Some(path) = path else { break; };
            if Instant::now() >= until { return Err(Error::CleanupFailed); }
            files::regular(&path, false)?;
            std::fs::remove_file(&path).map_err(|_| Error::CleanupFailed)?;
            match std::fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(Error::CleanupFailed),
            }
            lease.profile_outputs.lock().map_err(|_| Error::CleanupFailed)?.pop();
        }
    }
    let Some(path) = lease.directory()? else {
        return Ok(());
    };
    if Instant::now() >= until {
        return Err(Error::CleanupFailed);
    }
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
    fn cleanup_rejects_expired_fixed_point_before_touching_paths() {
        let lease = Lease::default();
        let root = tempfile::tempdir().unwrap();
        *lease.directory.lock().unwrap() = Some(root.path().to_path_buf());
        let until = Instant::now() - Duration::from_secs(1);
        assert!(matches!(
            cleanup_paths(&lease, until, false),
            Err(Error::CleanupFailed)
        ));
        assert!(root.path().exists());
    }

    #[test]
    fn cleanup_rejects_directory_type_change_and_keeps_record() {
        let lease = Lease::default();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("claimed");
        std::fs::write(&path, b"file").unwrap();
        *lease.directory.lock().unwrap() = Some(path.clone());
        let until = Instant::now() + Duration::from_secs(2);
        assert!(cleanup_paths(&lease, until, false).is_err());
        assert_eq!(lease.directory().unwrap(), Some(path));
    }
}
