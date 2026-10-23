//! Future 丢弃后仍由后台等待真实进程退出，租约不得随外层等待提前释放。
use crate::plugin_resources::ToolLease;
use std::{
    io,
    ops::{Deref, DerefMut},
    process::ExitStatus,
    sync::Arc,
};
use tokio::process::Child;

pub(super) struct Owner {
    child: Option<Child>,
    lease: Option<Arc<ToolLease>>,
    exited: bool,
}
impl Owner {
    pub(super) fn new(child: Child, lease: Arc<ToolLease>) -> Self {
        Self {
            child: Some(child),
            lease: Some(lease),
            exited: false,
        }
    }

    pub(super) async fn wait(&mut self) -> io::Result<ExitStatus> {
        let result = self.child.as_mut().expect("进程尚未移交").wait().await;
        if result.is_ok() {
            self.exited = true;
            if let Some(lease) = &self.lease {
                lease.process_exited();
            }
        }
        result
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
        if self.exited {
            return;
        }
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
        if self.child.wait().await.is_ok()
            && let Some(lease) = self.lease.take()
        {
            lease.process_exited();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_resources::{acquire, confirm_recovery, recovery_ready};
    use std::{sync::atomic::AtomicBool, time::Duration};
    use tokio::time::Instant;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn delayed_owner_drop_stays_pending_until_real_background_reap() {
        let owner = Arc::new(AtomicBool::new(true));
        let lease = acquire(
            None,
            &CancellationToken::new(),
            Instant::now() + Duration::from_secs(5),
            &owner,
        )
        .await
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("child-started");
        let executable = std::env::current_exe().unwrap();
        let mut command = tokio::process::Command::new(executable);
        command
            .args([
                "--exact",
                "plugin_resources::tests::child_process_waits_until_terminated_by_its_owner",
            ])
            .env("DEVICEFORGE_REPOSITORY_CHILD_MARKER", &marker)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let process = Owner::new(command.spawn().unwrap(), lease.clone());
        lease.retain();
        drop(lease);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !marker.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!recovery_ready(&owner));
        assert!(confirm_recovery(&owner).is_err());
        drop(process);
        // 当前单线程调度器尚未轮询新建的 reap，业务 owner 排空不等于退出。
        assert!(!recovery_ready(&owner));
        tokio::time::timeout(Duration::from_secs(5), async {
            while !recovery_ready(&owner) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        confirm_recovery(&owner).unwrap();
    }
}
