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
    pub async fn acquire_descendant_until(
        self,
        cancel: &CancellationToken,
        deadline: tokio::time::Instant,
        ancestor_read: bool,
    ) -> Result<Guard> {
        if ancestor_read && self.provider_write {
            return Err(Error::Conflict(
                "子调用不能把祖先持有的读屏障升级为写屏障".into(),
            ));
        }
        tokio::time::timeout_at(deadline, self.acquire_inner(cancel, ancestor_read))
            .await
            .map_err(|_| Error::Timeout)?
    }
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
        self.acquire_inner(cancel, false).await
    }
    async fn acquire_inner(self, cancel: &CancellationToken, ancestor_read: bool) -> Result<Guard> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let barrier = if self.provider_write {
            tokio::select! {biased; _=cancel.cancelled()=>return Err(Error::Cancelled),guard=self.barrier.write_owned()=>Barrier::Write{_guard:guard}}
        } else if ancestor_read {
            // 公平读写锁会让新读者排在写者后；祖先仍持读锁时不能等待该写者。
            Barrier::Read {
                _guard: self
                    .barrier
                    .try_read_owned()
                    .map_err(|_| Error::Conflict("子调用不能等待祖先持有的提供者屏障".into()))?,
            }
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
    #[tokio::test(start_paused = true)]
    async fn descendant_read_rejects_a_queued_writer_instead_of_waiting_its_ancestor() {
        let locks = Locks::default();
        let cancel = CancellationToken::new();
        let parent = locks
            .selection(
                "provider",
                Some("one"),
                &CapabilityScope::Device,
                &CapabilityAccess::Read,
            )
            .unwrap()
            .acquire(&cancel)
            .await
            .unwrap();
        let writer = locks
            .selection(
                "provider",
                None,
                &CapabilityScope::Provider,
                &CapabilityAccess::Write,
            )
            .unwrap();
        let writer = writer.acquire(&cancel);
        tokio::pin!(writer);
        assert!(futures_util::poll!(writer.as_mut()).is_pending());
        let child = locks
            .selection(
                "provider",
                Some("two"),
                &CapabilityScope::Device,
                &CapabilityAccess::Read,
            )
            .unwrap();
        assert!(matches!(
            child
                .acquire_descendant_until(
                    &cancel,
                    tokio::time::Instant::now() + std::time::Duration::from_secs(1),
                    true
                )
                .await,
            Err(Error::Conflict(_))
        ));
        // 拒绝子调用不释放祖先屏障；外部写者仍需等祖先正常结束。
        assert!(futures_util::poll!(writer.as_mut()).is_pending());
        drop(parent);
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn descendant_read_without_a_queued_writer_and_other_providers_stay_available() {
        let locks = Locks::default();
        let cancel = CancellationToken::new();
        let _parent = locks
            .selection(
                "provider",
                Some("one"),
                &CapabilityScope::Device,
                &CapabilityAccess::Write,
            )
            .unwrap()
            .acquire(&cancel)
            .await
            .unwrap();
        for provider in ["provider", "other"] {
            let child = locks
                .selection(
                    provider,
                    Some("two"),
                    &CapabilityScope::Device,
                    &CapabilityAccess::Write,
                )
                .unwrap();
            child
                .acquire_descendant_until(
                    &cancel,
                    tokio::time::Instant::now() + std::time::Duration::from_secs(1),
                    provider == "provider",
                )
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn descendant_cannot_upgrade_its_ancestor_read_barrier() {
        let locks = Locks::default();
        let cancel = CancellationToken::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        let _ancestor = locks
            .selection(
                "provider",
                Some("one"),
                &CapabilityScope::Device,
                &CapabilityAccess::Read,
            )
            .unwrap()
            .acquire_until(&cancel, deadline)
            .await
            .unwrap();
        let writer = locks
            .selection(
                "provider",
                None,
                &CapabilityScope::Provider,
                &CapabilityAccess::Write,
            )
            .unwrap();
        assert!(matches!(
            writer
                .acquire_descendant_until(&cancel, deadline, true)
                .await,
            Err(Error::Conflict(_))
        ));
    }
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
