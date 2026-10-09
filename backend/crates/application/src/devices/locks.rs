//! 跨代设备身份锁；弱引用池的升级和创建始终在同一短时锁内。
use apk_domain::{
    Error, Result,
    devices::{CapabilityAccess, CapabilityScope},
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{
    Mutex as AsyncMutex, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock,
};
use tokio_util::sync::CancellationToken;

type LockPool<K, T> = Mutex<BTreeMap<K, Weak<T>>>;
type DeviceIdentity = (String, String);

#[derive(Default)]
pub(crate) struct Locks {
    providers: LockPool<String, RwLock<()>>,
    devices: LockPool<DeviceIdentity, AsyncMutex<()>>,
    refreshes: LockPool<String, AsyncMutex<()>>,
}
pub(crate) struct Selection {
    barrier: Arc<RwLock<()>>,
    device: Option<Arc<AsyncMutex<()>>>,
    provider_write: bool,
}
pub(crate) enum Barrier {
    Read { _guard: OwnedRwLockReadGuard<()> },
    Write { _guard: OwnedRwLockWriteGuard<()> },
}
pub(crate) struct Guard {
    _barrier: Barrier,
    _device: Option<OwnedMutexGuard<()>>,
}
fn shared<K: Ord + Clone, T>(
    pool: &LockPool<K, T>,
    key: K,
    create: impl FnOnce() -> T,
) -> Result<Arc<T>> {
    let mut pool = pool
        .lock()
        .map_err(|_| Error::Storage("设备互斥池异常".into()))?;
    pool.retain(|_, value| value.strong_count() > 0);
    if let Some(value) = pool.get(&key).and_then(Weak::upgrade) {
        return Ok(value);
    }
    let value = Arc::new(create());
    pool.insert(key, Arc::downgrade(&value));
    Ok(value)
}
impl Locks {
    pub fn refresh(&self, provider: &str) -> Result<Arc<AsyncMutex<()>>> {
        shared(&self.refreshes, provider.into(), || AsyncMutex::new(()))
    }
    pub fn selection(
        &self,
        provider: &str,
        device: Option<&str>,
        scope: &CapabilityScope,
        access: &CapabilityAccess,
    ) -> Result<Selection> {
        let barrier = shared(&self.providers, provider.into(), || RwLock::new(()))?;
        let write = access == &CapabilityAccess::Write;
        let device = if write && scope == &CapabilityScope::Device {
            Some(shared(
                &self.devices,
                (provider.into(), device.expect("准入已校验设备").into()),
                || AsyncMutex::new(()),
            )?)
        } else {
            None
        };
        Ok(Selection {
            barrier,
            device,
            provider_write: write && scope == &CapabilityScope::Provider,
        })
    }
}
impl Selection {
    pub async fn acquire_until(
        self,
        cancel: &CancellationToken,
        deadline: tokio::time::Instant,
    ) -> Result<Guard> {
        tokio::time::timeout_at(deadline, self.acquire(cancel))
            .await
            .map_err(|_| Error::Timeout)?
    }
    pub async fn acquire(self, cancel: &CancellationToken) -> Result<Guard> {
        let barrier = if self.provider_write {
            tokio::select! {biased; _=cancel.cancelled()=>return Err(Error::Cancelled),guard=self.barrier.write_owned()=>Barrier::Write{_guard:guard}}
        } else {
            tokio::select! {biased; _=cancel.cancelled()=>return Err(Error::Cancelled),guard=self.barrier.read_owned()=>Barrier::Read{_guard:guard}}
        };
        let device = match self.device {
            Some(device) => Some(
                tokio::select! {biased; _=cancel.cancelled()=>return Err(Error::Cancelled),guard=device.lock_owned()=>guard},
            ),
            None => None,
        };
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        Ok(Guard {
            _barrier: barrier,
            _device: device,
        })
    }
}
pub(crate) async fn deadline(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_weak_pool_creation_has_one_shared_lock() {
        let locks = Arc::new(Locks::default());
        let barrier = Arc::new(std::sync::Barrier::new(12));
        let tasks = (0..12)
            .map(|_| {
                let locks = locks.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    locks
                        .selection(
                            "provider",
                            Some("stable"),
                            &CapabilityScope::Device,
                            &CapabilityAccess::Write,
                        )
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let selections = tasks
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect::<Vec<_>>();
        for selection in &selections {
            assert!(Arc::ptr_eq(&selections[0].barrier, &selection.barrier));
            assert!(Arc::ptr_eq(
                selections[0].device.as_ref().unwrap(),
                selection.device.as_ref().unwrap()
            ));
        }
    }
}
