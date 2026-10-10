use crate::{Error, Result};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Semaphore, time::Instant};
use tokio_util::sync::CancellationToken;

pub(crate) struct Lease {
    pub directory: Mutex<Option<PathBuf>>,
    pub slots: Arc<Semaphore>,
    cleanup_until: Mutex<Option<Instant>>,
}

impl Default for Lease {
    fn default() -> Self {
        Self {
            directory: Mutex::new(None),
            slots: Arc::new(Semaphore::new(1)),
            cleanup_until: Mutex::new(None),
        }
    }
}

impl Lease {
    pub(crate) fn cleanup_point(&self) -> Result<Instant> {
        let mut value = self
            .cleanup_until
            .lock()
            .map_err(|_| Error::CleanupFailed)?;
        Ok(*value.get_or_insert_with(|| Instant::now() + Duration::from_secs(2)))
    }

    pub(crate) fn directory(&self) -> Result<Option<PathBuf>> {
        self.directory
            .lock()
            .map(|path| path.clone())
            .map_err(|_| Error::CleanupFailed)
    }
}

pub(crate) struct Waiting {
    pub stop: CancellationToken,
    unresolved: Arc<AtomicBool>,
    lease: Weak<Lease>,
    armed: bool,
}

impl Waiting {
    pub(crate) fn new(
        stop: CancellationToken,
        unresolved: Arc<AtomicBool>,
        lease: &Arc<Lease>,
    ) -> Self {
        Self {
            stop,
            unresolved,
            lease: Arc::downgrade(lease),
            armed: true,
        }
    }

    pub(crate) fn confirmed(&mut self) {
        self.armed = false;
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        if self.armed {
            self.stop.cancel();
            self.unresolved.store(true, Ordering::Release);
            if let Some(lease) = self.lease.upgrade() {
                let _ = lease.cleanup_point();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_wait_fixes_cleanup_once_and_keeps_failure_sticky() {
        let lease = Arc::new(Lease::default());
        let unresolved = Arc::new(AtomicBool::new(false));
        let stop = CancellationToken::new();
        drop(Waiting::new(stop.clone(), unresolved.clone(), &lease));
        assert!(stop.is_cancelled());
        assert!(unresolved.load(Ordering::Acquire));
        let first = lease.cleanup_point().unwrap();
        assert_eq!(lease.cleanup_point().unwrap(), first);
        assert_eq!(Arc::strong_count(&lease), 1);
    }

    #[test]
    fn confirmation_does_not_cancel_or_renew_cleanup() {
        let lease = Arc::new(Lease::default());
        let first = lease.cleanup_point().unwrap();
        let unresolved = Arc::new(AtomicBool::new(false));
        let stop = CancellationToken::new();
        let mut waiting = Waiting::new(stop.clone(), unresolved.clone(), &lease);
        waiting.confirmed();
        drop(waiting);
        assert!(!stop.is_cancelled());
        assert!(!unresolved.load(Ordering::Acquire));
        assert_eq!(lease.cleanup_point().unwrap(), first);
    }
}
