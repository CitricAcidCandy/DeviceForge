use super::windows::Scope;
use crate::{ExecutionOptions, Result, ownership::Lease};
use std::{sync::Arc, time::Duration};
use tokio::{
    process::Child,
    time::{self, Instant},
};
use tokio_util::sync::CancellationToken;

pub(super) struct Owner {
    child: Option<Child>,
    scope: Option<Scope>,
    lease: Option<Lease>,
    cleanup_timeout: Duration,
    cleanup_deadline: Option<Instant>,
    stopped: bool,
}

impl Owner {
    pub(super) fn new(
        child: Child,
        scope: Scope,
        lease: Option<Lease>,
        cleanup_timeout: Duration,
    ) -> Self {
        Self {
            child: Some(child),
            scope: Some(scope),
            lease,
            cleanup_timeout,
            cleanup_deadline: None,
            stopped: false,
        }
    }

    pub(super) fn child(&mut self) -> &mut Child {
        self.child.as_mut().expect("工具范围尚未交接")
    }

    pub(super) fn activate(
        &mut self,
        options: &ExecutionOptions,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let child = self.child.as_ref().expect("工具范围尚未交接");
        let scope = self.scope.as_mut().expect("工具范围尚未交接");
        scope.assign(child)?;
        scope.resume(child, options, cancel)
    }

    pub(super) fn empty(&mut self) -> Result<bool> {
        self.scope.as_mut().expect("工具范围尚未交接").empty()
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        self.cleanup_deadline
    }

    pub(super) fn begin_cleanup(&mut self) {
        self.cleanup_deadline
            .get_or_insert_with(|| Instant::now() + self.cleanup_timeout);
    }

    pub(super) fn stop(&mut self) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        self.begin_cleanup();
        self.stopped = true;
        let result = self.scope.as_ref().expect("工具范围尚未交接").stop();
        let _ = self.child().start_kill();
        result
    }

    pub(super) fn confirmed(&mut self) {
        self.child.take();
        self.scope.take();
        self.lease.take();
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }
        let _ = self.stop();
        let pending = Pending {
            child: self.child.take(),
            scope: self.scope.take(),
            lease: self.lease.take(),
            confirmed: false,
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(pending.reap());
        }
    }
}

struct Pending {
    child: Option<Child>,
    scope: Option<Scope>,
    lease: Option<Arc<dyn Send + Sync>>,
    confirmed: bool,
}

impl Pending {
    async fn reap(mut self) {
        let mut direct_done = false;
        loop {
            if !direct_done {
                direct_done = matches!(
                    self.child.as_mut().expect("保留直接进程").try_wait(),
                    Ok(Some(_))
                );
            }
            let scope_done = self
                .scope
                .as_mut()
                .expect("保留完整工具范围")
                .empty()
                .unwrap_or(false);
            if direct_done && scope_done {
                self.child.take();
                self.scope.take();
                self.lease.take();
                self.confirmed = true;
                return;
            }
            time::sleep(Duration::from_millis(25)).await;
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.confirmed {
            if let Some(child) = self.child.take() {
                std::mem::forget(child);
            }
            if let Some(scope) = self.scope.take() {
                std::mem::forget(scope);
            }
            if let Some(lease) = self.lease.take() {
                std::mem::forget(lease);
            }
        }
    }
}
