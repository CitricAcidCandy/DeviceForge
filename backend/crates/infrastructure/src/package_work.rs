//! 包同步工作共用四槽容量，登记与关闭共用门禁；业务风险仍归各适配器。
use apk_domain::{Error, Result};
use std::sync::{Arc, Mutex, Weak};
use tokio::{sync::Semaphore, task::JoinHandle, time::Instant};

#[derive(Default)]
pub(crate) struct State {
    pub(crate) detached: bool,
    pub(crate) finished: bool,
}

#[cfg(test)]
mod tests;
#[derive(Default)]
struct Registry {
    closed: bool,
    states: Vec<Weak<Mutex<State>>>,
}

/// 由服务器显式共享；关闭后拒绝新工作，排空只证明实际同步闭包结束。
#[derive(Clone)]
pub struct PackageCapacity {
    pub(crate) slots: Arc<Semaphore>,
    registry: Arc<Mutex<Registry>>,
}
impl Default for PackageCapacity {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(4)),
            registry: Arc::default(),
        }
    }
}
impl PackageCapacity {
    pub(crate) fn spawn<T: Send + 'static>(
        &self,
        state: &Arc<Mutex<State>>,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<JoinHandle<Result<T>>> {
        let mut registry = self.registry.lock().map_err(|_| Error::CleanupFailed)?;
        if registry.closed {
            return Err(Error::Conflict("包工作容量已关闭".into()));
        }
        registry.states.retain(|state| state.strong_count() != 0);
        registry.states.push(Arc::downgrade(state));
        // 在同一门禁内登记并提交；close 返回后不会再提交未登记工作。
        Ok(tokio::task::spawn_blocking(work))
    }
    pub fn close(&self) -> Result<()> {
        let mut registry = self.registry.lock().map_err(|_| Error::CleanupFailed)?;
        registry.closed = true;
        self.slots.close();
        Ok(())
    }
    pub async fn drain_until(&self, deadline: Instant) -> Result<()> {
        loop {
            let finished = {
                let mut registry = self.registry.lock().map_err(|_| Error::CleanupFailed)?;
                if !registry.closed {
                    return Err(Error::Invalid("包工作排空前必须先关闭容量".into()));
                }
                registry.states.retain(|state| state.strong_count() != 0);
                registry
                    .states
                    .iter()
                    .filter_map(Weak::upgrade)
                    .all(|state| state.lock().is_ok_and(|state| state.finished))
            };
            if finished {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(Error::CleanupFailed);
            }
            tokio::time::sleep_until(
                deadline.min(Instant::now() + std::time::Duration::from_millis(2)),
            )
            .await;
        }
    }
}
