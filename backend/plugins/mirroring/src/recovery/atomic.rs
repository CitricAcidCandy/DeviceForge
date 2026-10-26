//! 同目录原子替换；Windows 额外等待写入穿透，Unix 刷新父目录。
use std::path::Path;

pub(crate) fn replace(pending: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
        }
        let source: Vec<_> = pending.as_os_str().encode_wide().chain([0]).collect();
        let target: Vec<_> = target.as_os_str().encode_wide().chain([0]).collect();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
        loop {
            if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 1 | 8) } != 0 {
                break;
            }
            let code = std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default();
            // 短暂共享冲突只在固定预算内重试，不删旧文件，也不退化为先删后写。
            if !matches!(code, 5 | 32 | 33) || std::time::Instant::now() >= deadline {
                return Err(format!("资源状态原子发布失败（Windows错误{code}）"));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(pending, target).map_err(|_| "资源状态原子发布失败")?;
    #[cfg(unix)]
    std::fs::File::open(target.parent().ok_or("资源状态父目录缺失")?)
        .and_then(|file| file.sync_all())
        .map_err(|_| "资源状态目录刷新失败")?;
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        fs::OpenOptions,
        os::windows::fs::OpenOptionsExt,
        sync::atomic::{AtomicU64, Ordering},
        time::{Duration, Instant},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn paths() -> (std::path::PathBuf, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "mirroring-atomic-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir(&directory).unwrap();
        let target = directory.join("state.json");
        let pending = directory.join("state.pending");
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(&pending, b"new").unwrap();
        (pending, target)
    }

    fn clean(pending: &Path, target: &Path) {
        if pending.exists() {
            std::fs::remove_file(pending).unwrap();
        }
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(target.parent().unwrap()).unwrap();
    }

    #[test]
    fn brief_windows_read_handle_conflict_preserves_atomic_replace() {
        let (pending, target) = paths();
        let reader = OpenOptions::new()
            .read(true)
            .share_mode(1 | 2)
            .open(&target)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(reader);
        });
        replace(&pending, &target).unwrap();
        release.join().unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert!(!pending.exists());
        clean(&pending, &target);
    }

    #[test]
    fn persistent_windows_handle_conflict_is_bounded_and_keeps_original_state() {
        let (pending, target) = paths();
        let reader = OpenOptions::new()
            .read(true)
            .share_mode(1 | 2)
            .open(&target)
            .unwrap();
        let started = Instant::now();
        let error = replace(&pending, &target).unwrap_err();
        assert!(error.contains("Windows错误"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert_eq!(std::fs::read(&pending).unwrap(), b"new");
        drop(reader);
        clean(&pending, &target);
    }

    #[test]
    fn missing_source_is_not_retried_as_a_sharing_conflict() {
        let (pending, target) = paths();
        std::fs::remove_file(&pending).unwrap();
        let error = replace(&pending, &target).unwrap_err();
        assert!(error.contains("Windows错误2"));
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        clean(&pending, &target);
    }
}
