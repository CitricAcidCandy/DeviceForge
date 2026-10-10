//! 直接进程退出之前保留调用者资源；异常收口不能以定时删除代替退出确认。
use std::sync::Arc;
use tokio::process::Child;

pub(crate) type Lease = Arc<dyn Send + Sync>;

pub(crate) struct Owner {
    child: Option<Child>,
    lease: Option<Lease>,
}
impl Owner {
    pub(crate) fn new(child: Child, lease: Option<Lease>) -> Self {
        Self {
            child: Some(child),
            lease,
        }
    }
    pub(crate) fn child(&mut self) -> &mut Child {
        self.child.as_mut().expect("工具所有权尚未交接")
    }
    pub(crate) fn confirmed(&mut self) {
        self.child.take();
        self.lease.take();
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        let Some(lease) = self.lease.take() else {
            return;
        };
        let Some(child) = self.child.take() else {
            return;
        };
        let pending = Pending {
            child,
            lease: Some(lease),
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(pending.reap());
        }
        // 没有运行时或运行时丢弃任务时，Pending 保留租约而不删除活动工具的目录。
    }
}

struct Pending {
    child: Child,
    lease: Option<Lease>,
}
impl Pending {
    async fn reap(mut self) {
        let _ = self.child.start_kill();
        if self.child.wait().await.is_ok() {
            self.lease.take();
        }
        // 等待失败无法证明退出；Drop 将资源保留至本宿主进程退出。
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            std::mem::forget(lease);
        }
    }
}
