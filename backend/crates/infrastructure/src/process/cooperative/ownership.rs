//! Future 丢弃后仍由后台等待真实进程退出，租约不得随外层等待提前释放。
use crate::plugin_resources::ToolLease;
use std::{
    ops::{Deref, DerefMut},
    sync::Arc,
};
use tokio::process::Child;

pub(super) struct Owner {
    child: Option<Child>,
    lease: Option<Arc<ToolLease>>,
}
impl Owner {
    pub(super) fn new(child: Child, lease: Arc<ToolLease>) -> Self {
        Self {
            child: Some(child),
            lease: Some(lease),
        }
    }
}
impl Deref for Owner {
    type Target = Child;
    fn deref(&self) -> &Child {
        self.child.as_ref().expect("进程尚未移交")
    }
}
impl DerefMut for Owner {
    fn deref_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("进程尚未移交")
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        let Some(child) = self.child.take() else {
            return;
        };
        let Some(lease) = self.lease.take() else {
            return;
        };
        let pending = Pending {
            child,
            lease: Some(lease),
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(pending.reap());
        }
    }
}
struct Pending {
    child: Child,
    lease: Option<Arc<ToolLease>>,
}
impl Pending {
    async fn reap(mut self) {
        let _ = self.child.start_kill();
        if self.child.wait().await.is_ok() {
            self.lease.take();
        }
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.retain();
        }
    }
}
