//! Windows 文件被短暂占用时只重试尚未成功的原子发布，不重放上层任务。
use std::{
    io,
    path::Path,
    time::{Duration, Instant},
};

struct Retry {
    started: Instant,
    attempts: u32,
    stage: &'static str,
}
impl Retry {
    fn new(stage: &'static str) -> Self {
        Self {
            started: Instant::now(),
            attempts: 0,
            stage,
        }
    }
    fn wait(&mut self, error: &io::Error) -> Option<Duration> {
        let retryable = cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33));
        let remaining = Duration::from_millis(500).checked_sub(self.started.elapsed());
        if !retryable || remaining.is_none_or(|value| value.is_zero()) {
            tracing::warn!(
                stage = self.stage,
                os_code = error.raw_os_error(),
                attempts = self.attempts,
                "文件未能保存，请按系统错误码排查；未重新执行插件或业务操作"
            );
            return None;
        }
        if self.attempts == 0 {
            tracing::warn!(
                stage = self.stage,
                os_code = error.raw_os_error(),
                "文件暂时无法替换，正在短暂等待；不会重新执行插件或业务操作"
            );
        }
        let delay = Duration::from_millis((5u64 << self.attempts.min(4)).min(80));
        self.attempts += 1;
        remaining.map(|left| delay.min(left))
    }
    fn succeeded(&self) {
        if self.attempts > 0 {
            tracing::info!(
                stage = self.stage,
                attempts = self.attempts,
                "文件占用等待结束，保存已完成"
            );
        }
    }
}

pub(crate) fn retry<T>(
    stage: &'static str,
    mut operation: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    let mut waiting = Retry::new(stage);
    loop {
        match operation() {
            Ok(value) => {
                waiting.succeeded();
                return Ok(value);
            }
            Err(error) => match waiting.wait(&error) {
                Some(delay) => std::thread::sleep(delay),
                None => return Err(error),
            },
        }
    }
}

pub(crate) async fn rename(source: &Path, target: &Path, stage: &'static str) -> io::Result<()> {
    let mut waiting = Retry::new(stage);
    loop {
        match tokio::fs::rename(source, target).await {
            Ok(()) => {
                waiting.succeeded();
                return Ok(());
            }
            Err(error) => match waiting.wait(&error) {
                Some(delay) => tokio::time::sleep(delay).await,
                None => return Err(error),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_lock_error_is_not_retried() {
        let mut calls = 0;
        let result: io::Result<()> = retry("测试记录", || {
            calls += 1;
            Err(io::Error::from_raw_os_error(2))
        });
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }

    #[cfg(windows)]
    #[test]
    fn persistent_lock_exits_within_short_budget() {
        let before = Instant::now();
        let result: io::Result<()> =
            retry("测试记录", || Err(io::Error::from_raw_os_error(32)));
        assert_eq!(result.unwrap_err().raw_os_error(), Some(32));
        assert!(before.elapsed() < Duration::from_secs(2));
    }

    #[cfg(windows)]
    #[test]
    fn real_windows_share_lock_releases_without_replaying_publication() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let (source, target) = (
            directory.path().join("new"),
            directory.path().join("active"),
        );
        std::fs::write(&source, b"new-build").unwrap();
        std::fs::write(&target, b"previous-build").unwrap();
        // 允许普通读取和写入，但模拟未授予删除共享的扫描器句柄。
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(&target)
            .unwrap();
        assert!(std::fs::rename(&source, &target).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"previous-build");
        let closer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(70));
            drop(held);
        });
        retry("测试实际文件发布", || {
            std::fs::rename(&source, &target)
        })
        .unwrap();
        closer.join().unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"new-build");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn async_report_publication_waits_for_real_share_lock() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let (source, target) = (
            directory.path().join("staged"),
            directory.path().join("published"),
        );
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("content"), b"report").unwrap();
        // 目录句柄使用 Windows 的 BACKUP_SEMANTICS，模拟未开放删除共享的占用。
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .custom_flags(0x02000000)
            .open(&source)
            .unwrap();
        assert!(std::fs::rename(&source, &target).is_err());
        let closer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(70));
            drop(held);
        });
        rename(&source, &target, "测试报告保存").await.unwrap();
        closer.join().unwrap();
        assert_eq!(std::fs::read(target.join("content")).unwrap(), b"report");
    }
}
