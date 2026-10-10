//! 非合作传输的直接进程清理守卫；未返回退出确认时禁止复用插件资源。
use apk_domain::{Error, Result};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(super) struct Guard {
    unresolved: Arc<AtomicBool>,
    confirmed: bool,
}

impl Guard {
    pub fn new(unresolved: Arc<AtomicBool>) -> Self {
        Self {
            unresolved,
            confirmed: false,
        }
    }

    pub fn observe(&mut self, result: &Result<Vec<u8>>) {
        // 普通失败只有在公共库已确认退出后才返回；清理失败不得确认。
        self.confirmed = !matches!(result, Err(Error::CleanupFailed));
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.confirmed {
            self.unresolved.store(true, Ordering::Release);
            tracing::warn!(cleanup = "unresolved", "插件直接进程退出未确认");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_or_failed_cleanup_remains_unconfirmed_after_later_success() {
        let unresolved = Arc::new(AtomicBool::new(false));
        drop(Guard::new(unresolved.clone()));
        assert!(unresolved.load(Ordering::Acquire));
        let mut guard = Guard::new(unresolved.clone());
        guard.observe(&Ok(Vec::new()));
        drop(guard);
        assert!(unresolved.load(Ordering::Acquire));
        let unresolved = Arc::new(AtomicBool::new(false));
        let mut guard = Guard::new(unresolved.clone());
        guard.observe(&Err(Error::CleanupFailed));
        drop(guard);
        assert!(unresolved.load(Ordering::Acquire));
    }

    #[test]
    fn confirmed_exit_does_not_confuse_normal_failure_with_cleanup_failure() {
        for result in [
            Ok(Vec::new()),
            Err(Error::Cancelled),
            Err(Error::Timeout),
            Err(Error::Dependency("工具失败".into())),
        ] {
            let unresolved = Arc::new(AtomicBool::new(false));
            let mut guard = Guard::new(unresolved.clone());
            guard.observe(&result);
            drop(guard);
            assert!(!unresolved.load(Ordering::Acquire));
        }
    }
}
